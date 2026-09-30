import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRequest,
  enqueueJob,
  getJob,
  getRequest,
  listAcquisitionItems,
  listJobsForRequest,
  listRequestEvents,
  openDatabase,
  transitionRequest,
  type RequestRow,
} from "@subwave-ai/db";
import { UnverifiedAcquisitionProvider, type ProviderBundle, type SayRequest } from "@subwave-ai/providers";
import { loadConfig, type RequestStatus } from "@subwave-ai/shared";
import type { WorkerContext } from "./context.js";
import { handleDownload, handleSearchAcquisition } from "./processors/acquire.js";
import { setFfprobeRunner } from "./processors/ffprobe.js";
import { handleValidateFile } from "./processors/files.js";

const VIA_ACQUISITION: RequestStatus[] = [
  "CLASSIFYING",
  "APPROVED",
  "CHECKING_LIBRARY",
  "SEARCHING",
  "QUEUED",
  "DOWNLOADING",
  "DOWNLOAD_COMPLETE",
  "VALIDATING",
  "IMPORTING",
];

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-a5-"));
  const secrets = path.join(dir, "secrets");
  mkdirSync(secrets);
  writeFileSync(path.join(secrets, "admin_password"), "x");
  writeFileSync(path.join(secrets, "slskd_api_key"), "test-key");
  const downloads = path.join(dir, "downloads");
  mkdirSync(downloads);
  const cfgPath = path.join(dir, "subwave.yaml");
  writeFileSync(
    cfgPath,
    `
server:
  host: "127.0.0.1"
  port: 8788
database:
  path: ":memory:"
paths:
  secrets_dir: "${secrets}"
  downloads: "${downloads}"
  staging: "${path.join(dir, "staging")}"
  library: "${path.join(dir, "library")}"
files:
  allowed_extensions: [".mp3", ".flac", ".m4a", ".ogg", ".wav"]
llm:
  base_url: "http://ollama.test"
  model: "test-model"
library:
  base_url: "http://navidrome.test"
  username: "nd"
radio:
  base_url: "http://radio.test/api"
  admin_user: "dj"
acquisition:
  provider: slskd
  base_url: "http://slskd.test"
  verify_status: verified
worker:
  id: "worker-test"
`,
  );
  const config = loadConfig({ configPath: cfgPath });
  const db = openDatabase(":memory:");
  return { dir, config, db, downloads, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function advance(
  db: ReturnType<typeof openDatabase>,
  id: string,
  to: RequestStatus,
  patch?: Partial<Pick<RequestRow, "artist" | "title">>,
): void {
  for (const status of VIA_ACQUISITION) {
    transitionRequest(db, {
      requestId: id,
      to: status,
      actor: "test",
      patch: status === to ? patch : undefined,
    });
    if (status === to) return;
  }
  throw new Error(`unreachable status ${to}`);
}

type AcqState = {
  searchComplete?: boolean;
  responses?: unknown[];
  enqueueError?: Error;
  transfers?: unknown;
};

function harness(state: AcqState = {}) {
  const order: string[] = [];
  const say: SayRequest[] = [];
  const enqueued: Array<{ user: string; files: unknown }> = [];
  let transfers: unknown = state.transfers ?? [];

  const acquisition: ProviderBundle["acquisition"] = {
    kind: "slskd",
    verifyStatus: "verified",
    search: async () => {
      order.push("acq-search");
      return { id: "search-1" };
    },
    getSearch: async () => {
      order.push("get-search");
      return {
        id: "search-1",
        isComplete: state.searchComplete !== false,
        state: state.searchComplete === false ? "InProgress" : "Completed",
        responses: state.responses ?? [],
      };
    },
    getSearchResponses: async () => {
      order.push("get-responses");
      return state.responses ?? [];
    },
    enqueueDownload: async (user, files) => {
      order.push("enqueue");
      if (state.enqueueError) throw state.enqueueError;
      enqueued.push({ user, files });
      return { ok: true };
    },
    listDownloads: async () => {
      order.push("list");
      return transfers;
    },
    health: async () => ({ ok: true, verifyStatus: "verified", checked_at: "t" }),
  };

  const radio: ProviderBundle["radio"] = {
    kind: "subwave",
    verifyStatus: "verified",
    health: async () => ({ ok: true, verifyStatus: "verified", checked_at: "t" }),
    nowPlaying: async () => ({}),
    state: async () => ({}),
    djSearch: async () => ({ results: [] }),
    queueTrack: async () => ({ ok: true }),
    refreshPlaylist: async () => ({}),
    say: async (input) => {
      order.push("say");
      say.push(input);
      return { ok: true, mode: "styled", kind: input.kind ?? "dj-speak", spoken: input.text };
    },
    publicRequest: async () => ({}),
    publicRequestStatus: async () => ({}),
  };

  const library: ProviderBundle["library"] = {
    kind: "navidrome",
    verifyStatus: "verified",
    search3: async () => [],
    getSong: async () => null,
    startScan: async () => ({}),
    getScanStatus: async () => ({}),
    health: async () => ({ ok: true, verifyStatus: "verified", checked_at: "t" }),
  };

  return {
    acquisition,
    radio,
    library,
    order,
    say,
    enqueued,
    setTransfers: (next: unknown) => {
      transfers = next;
    },
  };
}

const TRACK_SIZE = 8 * 1024 * 1024;
const HIT = {
  username: "peer-a",
  id: "resp-a",
  files: [{ filename: "\\\\music\\\\track.flac", size: TRACK_SIZE, extension: "flac", id: 7 }],
};

describe("A5 acquisition worker", () => {
  const cleanups: Array<() => void> = [];
  beforeEach(() => {
    setFfprobeRunner(async (_bin, filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".flac") return { codecName: "flac", formatName: "flac", durationSeconds: 180 };
      if (ext === ".mp3") return { codecName: "mp3", formatName: "mp3", durationSeconds: 180 };
      return "failed";
    });
  });
  afterEach(() => {
    setFfprobeRunner(undefined);
    while (cleanups.length) cleanups.pop()?.();
  });

  it("polls search until complete, selects, enqueues, then waits on in-progress transfer", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { acquisition, radio, library, order, say, enqueued, setTransfers } = harness({
      searchComplete: false,
      responses: [],
    });
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "QUEUED", { artist: "Artist", title: "Track" });
    const ctx: WorkerContext = {
      db,
      config,
      providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
      workerId: "worker-test",
    };

    const waiting = await handleDownload(
      ctx,
      enqueueJob(db, { type: "download", requestId: request.id, payload: { searchId: "search-1" } }),
    );
    expect(waiting).toMatchObject({ waiting: true, reason: "search_incomplete" });
    expect(order).toEqual(["get-search"]);
    expect(say).toEqual([]);
    expect(getRequest(db, request.id)?.status).toBe("QUEUED");

    // Complete search with a hit, enqueue succeeds, transfer still in progress.
    (acquisition as { getSearch: typeof acquisition.getSearch }).getSearch = async () => {
      order.push("get-search");
      return { id: "search-1", isComplete: true, state: "Completed", responses: [HIT] };
    };
    const enq = await handleDownload(
      ctx,
      enqueueJob(db, { type: "download", requestId: request.id, payload: { searchId: "search-1" } }),
    );
    expect(enq).toMatchObject({ enqueued: true });
    expect(enqueued).toEqual([{ user: "peer-a", files: [{ filename: "\\\\music\\\\track.flac", size: TRACK_SIZE }] }]);
    expect(order).toContain("enqueue");
    expect(order).toContain("say");
    expect(say[0]?.text).toContain("REQUEST_ACCEPTED");
    expect(getRequest(db, request.id)?.status).toBe("DOWNLOADING");
    const accepted = listRequestEvents(db, request.id).find((event) => event.to_status === "DOWNLOADING");
    expect(JSON.parse(accepted?.payload_json ?? "{}").event).toBe("REQUEST_ACCEPTED");

    setTransfers([
      {
        username: "peer-a",
        filename: "\\\\music\\\\track.flac",
        size: TRACK_SIZE,
        state: "InProgress",
        percentComplete: 10,
      },
    ]);
    const poll = listJobsForRequest(db, request.id).filter((job) => job.type === "download").at(-1)!;
    const inProgress = await handleDownload(ctx, poll);
    expect(inProgress).toMatchObject({ waiting: true, reason: "transfer_in_progress" });
    expect(getRequest(db, request.id)?.status).toBe("DOWNLOADING");
  });

  it("fails enqueue without announcing REQUEST_ACCEPTED", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { acquisition, radio, library, order, say } = harness({
      responses: [HIT],
      enqueueError: new Error("enqueue refused"),
    });
    const request = createRequest(db, { rawQuery: "x" });
    advance(db, request.id, "QUEUED");
    await expect(
      handleDownload(
        {
          db,
          config,
          providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
          workerId: "worker-test",
        },
        enqueueJob(db, { type: "download", requestId: request.id, payload: { searchId: "search-1" } }),
      ),
    ).rejects.toThrow(/enqueue refused/);
    expect(order).toContain("enqueue");
    expect(order).not.toContain("say");
    expect(say).toEqual([]);
    expect(getRequest(db, request.id)?.status).toBe("QUEUED");
  });

  it("completes only on Completed+Succeeded with real file handoff", async () => {
    const { config, db, downloads, cleanup } = fixture();
    cleanups.push(cleanup);
    mkdirSync(path.join(downloads, "music"));
    writeFileSync(path.join(downloads, "music", "track.flac"), Buffer.alloc(100));
    const { acquisition, radio, library, order } = harness({
      transfers: [
        {
          username: "peer-a",
          filename: "\\\\music\\\\track.flac",
          size: 100,
          state: "Completed, Succeeded",
          id: "tx-1",
        },
        {
          username: "noise",
          filename: "other.mp3",
          size: 9,
          state: "Completed, Succeeded",
          id: "tx-noise",
        },
      ],
    });
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "DOWNLOADING", { artist: "Artist", title: "Track" });
    const result = await handleDownload(
      {
        db,
        config,
        providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
        workerId: "worker-test",
      },
      enqueueJob(db, {
        type: "download",
        requestId: request.id,
        payload: {
          enqueued: true,
          selected: {
            username: "peer-a",
            filename: "\\\\music\\\\track.flac",
            size: 100,
            fileId: "7",
            durationSeconds: 180,
          },
        },
      }),
    );
    expect(result).toMatchObject({ completed: true, basename: "track.flac" });
    expect(getRequest(db, request.id)?.status).toBe("DOWNLOAD_COMPLETE");
    expect(order).toEqual(["list"]);
    const validate = listJobsForRequest(db, request.id).find((job) => job.type === "validate_file");
    expect(JSON.parse(validate?.payload_json ?? "{}")).toEqual({
      filename: path.join("music", "track.flac"),
      path: path.join(downloads, "music", "track.flac"),
      size: 100,
      duration_seconds: 180,
    });
    await handleValidateFile(
      {
        db,
        config,
        providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
        workerId: "worker-test",
      },
      validate!,
    );
    expect(getRequest(db, request.id)?.status).toBe("VALIDATING");
  });

  it("fails on errored transfer and does not DOWNLOAD_COMPLETE", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { acquisition, radio, library } = harness({
      transfers: [
        {
          username: "peer-a",
          filename: "\\\\music\\\\track.flac",
          size: 100,
          state: "Completed, Errored",
        },
      ],
    });
    const request = createRequest(db, { rawQuery: "x" });
    advance(db, request.id, "DOWNLOADING");
    const job = enqueueJob(db, {
      type: "download",
      requestId: request.id,
      payload: {
        enqueued: true,
        selected: { username: "peer-a", filename: "\\\\music\\\\track.flac", size: 100 },
      },
    });
    const result = await handleDownload(
      {
        db,
        config,
        providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
        workerId: "worker-test",
      },
      job,
    );
    expect(result).toEqual({ failed: true, reason: "Completed, Errored" });
    expect(getRequest(db, request.id)?.status).toBe("FAILED");
    expect(getRequest(db, request.id)?.error).toBe("Completed, Errored");
    expect(listJobsForRequest(db, request.id).filter((item) => item.type === "download")).toHaveLength(1);
  });

  it("rejects unrelated completed transfers (no false-complete)", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { acquisition, radio, library } = harness({
      transfers: [
        {
          username: "someone-else",
          filename: "unrelated.mp3",
          size: 50,
          state: "Completed, Succeeded",
        },
      ],
    });
    const request = createRequest(db, { rawQuery: "x" });
    advance(db, request.id, "DOWNLOADING");
    const result = await handleDownload(
      {
        db,
        config,
        providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
        workerId: "worker-test",
      },
      enqueueJob(db, {
        type: "download",
        requestId: request.id,
        payload: {
          enqueued: true,
          selected: { username: "peer-a", filename: "\\\\music\\\\track.flac", size: 100 },
        },
      }),
    );
    expect(result).toMatchObject({ waiting: true, reason: "transfer_not_found" });
    expect(getRequest(db, request.id)?.status).toBe("DOWNLOADING");
  });

  it("fails when Completed+Succeeded but file is missing under downloads", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { acquisition, radio, library } = harness({
      transfers: [
        {
          username: "peer-a",
          filename: "\\\\music\\\\track.flac",
          size: 100,
          state: "Completed, Succeeded",
        },
      ],
    });
    const request = createRequest(db, { rawQuery: "x" });
    advance(db, request.id, "DOWNLOADING");
    const result = await handleDownload(
      {
        db,
        config,
        providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
        workerId: "worker-test",
      },
      enqueueJob(db, {
        type: "download",
        requestId: request.id,
        payload: {
          enqueued: true,
          selected: { username: "peer-a", filename: "\\\\music\\\\track.flac", size: 100 },
        },
      }),
    );
    expect(result).toMatchObject({ failed: true, reason: "download_not_found" });
    expect(getRequest(db, request.id)?.status).toBe("FAILED");
    expect(getRequest(db, request.id)?.error).toBe(
      `download_not_found: tried ${path.join(config.paths.downloads, "music", "track.flac")}`,
    );
  });

  it("reaches DOWNLOADING and schedules a poll when say throws, with one enqueue", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { acquisition, radio, library, order, enqueued } = harness({ responses: [HIT] });
    radio.say = async () => {
      order.push("say");
      throw new Error("say failed");
    };
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "QUEUED", { artist: "Artist", title: "Track" });
    const ctx: WorkerContext = {
      db,
      config,
      providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
      workerId: "worker-test",
    };
    const job = enqueueJob(db, { type: "download", requestId: request.id, payload: { searchId: "search-1" } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const started = Date.now();
      const result = await handleDownload(ctx, job);
      expect(result).toMatchObject({ enqueued: true });
      expect(enqueued).toHaveLength(1);
      expect(order.filter((step) => step === "enqueue")).toHaveLength(1);
      expect(order).toContain("say");
      expect(getRequest(db, request.id)?.status).toBe("DOWNLOADING");
      expect(getRequest(db, request.id)?.error).toBeNull();
      const moved = listRequestEvents(db, request.id).find((event) => event.to_status === "DOWNLOADING");
      expect(JSON.parse(moved?.payload_json ?? "{}").event).toBe("REQUEST_ACCEPTED");
      const polls = listJobsForRequest(db, request.id).filter((row) => row.type === "download" && row.id !== job.id);
      expect(polls).toHaveLength(1);
      expect(polls[0]?.status).toBe("queued");
      expect(polls[0]?.run_after).toBeGreaterThanOrEqual(started);
      expect(JSON.parse(polls[0]?.payload_json ?? "{}").enqueued).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("moves a saved enqueue to DOWNLOADING when say fails and does not post again", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { acquisition, radio, library, order, enqueued } = harness();
    radio.say = async () => {
      order.push("say");
      throw new Error("say failed");
    };
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "QUEUED", { artist: "Artist", title: "Track" });
    const ctx: WorkerContext = {
      db,
      config,
      providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
      workerId: "worker-test",
    };
    const job = enqueueJob(db, {
      type: "download",
      requestId: request.id,
      payload: {
        enqueued: true,
        download_started_at: Date.now(),
        selected: { username: "peer-a", filename: "\\\\music\\\\track.flac", size: TRACK_SIZE },
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const started = Date.now();
      const result = await handleDownload(ctx, job);
      expect(result).toMatchObject({ enqueued: true });
      expect(enqueued).toEqual([]);
      expect(order).not.toContain("enqueue");
      expect(order).toContain("say");
      expect(getRequest(db, request.id)?.status).toBe("DOWNLOADING");
      expect(getRequest(db, request.id)?.error).toBeNull();
      const polls = listJobsForRequest(db, request.id).filter((row) => row.type === "download" && row.id !== job.id);
      expect(polls).toHaveLength(1);
      expect(polls[0]?.status).toBe("queued");
      expect(polls[0]?.run_after).toBeGreaterThanOrEqual(started);
      expect(JSON.parse(polls[0]?.payload_json ?? "{}").enqueued).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not post again when a reclaimed lease finds the transfer already listed", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { acquisition, radio, library, order, enqueued, say } = harness({
      responses: [HIT],
      transfers: [
        {
          username: "peer-a",
          filename: "\\\\music\\\\track.flac",
          size: TRACK_SIZE,
          state: "Queued",
          id: "tx-existing",
        },
      ],
    });
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "QUEUED", { artist: "Artist", title: "Track" });
    const result = await handleDownload(
      {
        db,
        config,
        providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
        workerId: "worker-test",
      },
      enqueueJob(db, { type: "download", requestId: request.id, payload: { searchId: "search-1" } }),
    );
    expect(result).toMatchObject({ enqueued: true });
    expect(enqueued).toEqual([]);
    expect(order).not.toContain("enqueue");
    expect(order).toContain("list");
    expect(say).toHaveLength(1);
    expect(getRequest(db, request.id)?.status).toBe("DOWNLOADING");
  });

  it.each(["Completed, TimedOut", "Completed, Rejected", "Failed", "Completed, Errored", "Completed, Cancelled"])(
    "fails a %s transfer without scheduling another download",
    async (state) => {
      const { config, db, cleanup } = fixture();
      cleanups.push(cleanup);
      const { acquisition, radio, library } = harness({
        transfers: [
          {
            username: "peer-a",
            filename: "\\\\music\\\\track.flac",
            size: 100,
            state,
          },
        ],
      });
      const request = createRequest(db, { rawQuery: "x" });
      advance(db, request.id, "DOWNLOADING");
      const result = await handleDownload(
        {
          db,
          config,
          providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
          workerId: "worker-test",
        },
        enqueueJob(db, {
          type: "download",
          requestId: request.id,
          payload: {
            enqueued: true,
            download_started_at: Date.now(),
            selected: { username: "peer-a", filename: "\\\\music\\\\track.flac", size: 100 },
          },
        }),
      );
      expect(result).toEqual({ failed: true, reason: state });
      expect(getRequest(db, request.id)?.status).toBe("FAILED");
      expect(getRequest(db, request.id)?.error).toBe(state);
      expect(listJobsForRequest(db, request.id).filter((job) => job.type === "download")).toHaveLength(1);
    },
  );

  it("fails download_timeout without calling slskd again", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    config.acquisition.download_timeout_ms = 1_000;
    const { acquisition, radio, library, order } = harness({
      transfers: [
        {
          username: "peer-a",
          filename: "\\\\music\\\\track.flac",
          size: 100,
          state: "InProgress",
        },
      ],
    });
    const request = createRequest(db, { rawQuery: "x" });
    advance(db, request.id, "DOWNLOADING");
    const result = await handleDownload(
      {
        db,
        config,
        providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
        workerId: "worker-test",
      },
      enqueueJob(db, {
        type: "download",
        requestId: request.id,
        payload: {
          enqueued: true,
          download_started_at: Date.now() - 60_000,
          selected: { username: "peer-a", filename: "\\\\music\\\\track.flac", size: 100 },
        },
      }),
    );
    expect(result).toEqual({ failed: true, reason: "download_timeout" });
    expect(getRequest(db, request.id)?.error).toBe("download_timeout");
    expect(order).toEqual([]);
    expect(listJobsForRequest(db, request.id).filter((job) => job.type === "download")).toHaveLength(1);
  });

  it("resolves a file saved under the remote parent folder", async () => {
    const { config, db, downloads, cleanup } = fixture();
    cleanups.push(cleanup);
    const remote = "\\\\music\\\\Album\\\\track.flac";
    mkdirSync(path.join(downloads, "Album"));
    writeFileSync(path.join(downloads, "Album", "track.flac"), Buffer.alloc(100));
    const { acquisition, radio, library } = harness({
      transfers: [{ username: "peer-a", filename: remote, size: 100, state: "Completed, Succeeded" }],
    });
    const request = createRequest(db, { rawQuery: "x" });
    advance(db, request.id, "DOWNLOADING");
    const result = await handleDownload(
      {
        db,
        config,
        providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
        workerId: "worker-test",
      },
      enqueueJob(db, {
        type: "download",
        requestId: request.id,
        payload: {
          enqueued: true,
          download_started_at: Date.now(),
          selected: { username: "peer-a", filename: remote, size: 100 },
        },
      }),
    );
    expect(result).toMatchObject({ completed: true, basename: "track.flac" });
    const validate = listJobsForRequest(db, request.id).find((job) => job.type === "validate_file");
    expect(JSON.parse(validate?.payload_json ?? "{}").filename).toBe(path.join("Album", "track.flac"));
  });

  it("does not use a basename sitting directly in downloads", async () => {
    const { config, db, downloads, cleanup } = fixture();
    cleanups.push(cleanup);
    const folder = "Beatport Top 100 Techno (Peak Time, Driving) April 2025";
    const filename = "Adam Beyer - Don't Go (Original Mix).mp3";
    const remote = `\\\\share\\\\${folder}\\\\${filename}`;
    writeFileSync(path.join(downloads, filename), Buffer.alloc(80));
    const { acquisition, radio, library } = harness({
      transfers: [{ username: "peer-a", filename: remote, size: 80, state: "Completed, Succeeded" }],
    });
    const request = createRequest(db, { rawQuery: "x" });
    advance(db, request.id, "DOWNLOADING");
    const result = await handleDownload(
      {
        db,
        config,
        providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
        workerId: "worker-test",
      },
      enqueueJob(db, {
        type: "download",
        requestId: request.id,
        payload: {
          enqueued: true,
          download_started_at: Date.now(),
          selected: { username: "peer-a", filename: remote, size: 80 },
        },
      }),
    );
    expect(result).toMatchObject({ failed: true, reason: "download_not_found" });
    expect(getRequest(db, request.id)?.error).toBe(
      `download_not_found: tried ${path.join(downloads, folder, filename)}`,
    );
    expect(existsSync(path.join(downloads, filename))).toBe(true);
  });

  it("enqueues the normal-length remix and records the score breakdown", async () => {
    const album = "\\\\music\\\\Album\\\\Get Lucky.flac";
    const remix = "\\\\music\\\\Remix\\\\Get Lucky (Remix).flac";
    const responses = [
      {
        username: "remix-peer",
        hasFreeUploadSlot: true,
        queueLength: 0,
        uploadSpeed: 9_000_000,
        files: [
          {
            filename: remix,
            size: 30_000_000,
            extension: "flac",
            // 48 kHz stays eligible. This case is the version penalty, not the sample-rate cap.
            bitDepth: 24,
            sampleRate: 48000,
            length: 400,
          },
        ],
      },
      {
        username: "album-peer",
        hasFreeUploadSlot: true,
        queueLength: 2,
        uploadSpeed: 100_000,
        files: [
          {
            filename: album,
            size: 40_000_000,
            extension: "flac",
            bitDepth: 16,
            sampleRate: 44100,
            length: 248,
          },
        ],
      },
    ];

    async function chosen(title: string) {
      const { config, db, cleanup } = fixture();
      cleanups.push(cleanup);
      const { acquisition, radio, library, enqueued } = harness({ responses });
      const request = createRequest(db, { rawQuery: `Daft Punk - ${title}` });
      advance(db, request.id, "QUEUED", { artist: "Daft Punk", title });
      const result = await handleDownload(
        {
          db,
          config,
          providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
          workerId: "worker-test",
        },
        enqueueJob(db, { type: "download", requestId: request.id, payload: { searchId: "search-1" } }),
      );
      const accepted = listRequestEvents(db, request.id).find((event) => event.to_status === "DOWNLOADING");
      const payload = JSON.parse(accepted?.payload_json ?? "{}") as {
        event?: string;
        selection_score?: { breakdown: Record<string, number>; total: number };
      };
      expect(payload.event).toBe("REQUEST_ACCEPTED");
      expect(payload.selection_score?.total).toBe(
        Object.values(payload.selection_score?.breakdown ?? {}).reduce((sum, value) => sum + value, 0),
      );
      expect(result).toMatchObject({ selection_score: payload.selection_score });
      return { enqueued, score: payload.selection_score };
    }

    const plain = await chosen("Get Lucky");
    expect(plain.enqueued).toEqual([{ user: "remix-peer", files: [{ filename: remix, size: 30_000_000 }] }]);
    expect(plain.score?.breakdown.versionPreference).toBeGreaterThan(0);
    expect(plain.score?.breakdown.requestedVersion).toBe(0);
    const asked = await chosen("Get Lucky Remix");
    expect(asked.enqueued).toEqual([{ user: "remix-peer", files: [{ filename: remix, size: 30_000_000 }] }]);
    expect(asked.score?.breakdown.requestedVersion).toBeGreaterThan(0);
  });

  it("fails QUEUED with no_suitable_result when filters remove every candidate and does not enqueue", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const mib = 1024 * 1024;
    const { acquisition, radio, library, order, say, enqueued } = harness({
      responses: [
        {
          username: "peer",
          hasFreeUploadSlot: true,
          queueLength: 0,
          uploadSpeed: 1_000_000,
          files: [
            { filename: "\\\\music\\\\notes.txt", size: 1000, extension: "txt" },
            { filename: "\\\\music\\\\huge.flac", size: 400 * mib, extension: "flac", bitDepth: 16, sampleRate: 44100 },
            { filename: "\\\\music\\\\hires.flac", size: 40 * mib, extension: "flac", bitDepth: 24, sampleRate: 192000 },
            { filename: "\\\\music\\\\deep.flac", size: 40 * mib, extension: "flac", bitDepth: 32, sampleRate: 44100 },
            {
              filename: "\\\\music\\\\locked.flac",
              size: 40 * mib,
              extension: "flac",
              bitDepth: 16,
              sampleRate: 44100,
              isLocked: true,
            },
          ],
          lockedFiles: [
            { filename: "\\\\music\\\\album.flac", size: 40 * mib, extension: "flac", bitDepth: 16, sampleRate: 44100 },
          ],
        },
      ],
    });
    const request = createRequest(db, { rawQuery: "Daft Punk - Get Lucky" });
    advance(db, request.id, "QUEUED", { artist: "Daft Punk", title: "Get Lucky" });
    const job = enqueueJob(db, { type: "download", requestId: request.id, payload: { searchId: "search-1" } });
    await expect(
      handleDownload(
        {
          db,
          config,
          providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
          workerId: "worker-test",
        },
        job,
      ),
    ).rejects.toThrow(/no_suitable_result/);
    const row = getRequest(db, request.id);
    expect(row?.status).toBe("FAILED");
    expect(row?.error).toBe(
      "no_suitable_result: locked=2, junk=0, extensions=1, format_preference=0, min_file_size=0, max_file_size=0, max_duration=0, max_sample_rate=0, max_bit_depth=0, title_mismatch=3, medley=0, tribute_or_cover=0, artist_mismatch=0, stem=0, unaccepted_version=0, long_recording=0, under_bitrate=0, short_recording=0",
    );
    const failed = listRequestEvents(db, request.id).find((event) => event.to_status === "FAILED");
    expect(failed?.from_status).toBe("QUEUED");
    expect(JSON.parse(failed?.payload_json ?? "{}")).toMatchObject({
      outcome: "no_suitable_result",
      removed: {
        locked: 2,
        junk: 0,
        extensions: 1,
        format_preference: 0,
        min_file_size: 0,
        max_file_size: 0,
        max_duration: 0,
        max_sample_rate: 0,
        max_bit_depth: 0,
        title_mismatch: 3,
      },
    });
    expect(enqueued).toEqual([]);
    expect(say).toEqual([]);
    expect(order).toEqual(["get-search"]);
    expect(listJobsForRequest(db, request.id).filter((item) => item.type === "download")).toHaveLength(1);
  });

  it("surfaces acquire_unavailable without calling the provider", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const request = createRequest(db, { rawQuery: "no daemon" });
    advance(db, request.id, "SEARCHING");
    await expect(
      handleSearchAcquisition(
        {
          db,
          config,
          providers: {
            llm: {} as ProviderBundle["llm"],
            library: {} as ProviderBundle["library"],
            radio: {} as ProviderBundle["radio"],
            acquisition: new UnverifiedAcquisitionProvider(),
          },
          workerId: "worker-test",
        },
        enqueueJob(db, { type: "search_acquisition", requestId: request.id }),
      ),
    ).rejects.toThrow(/acquire_unavailable/);
    expect(getRequest(db, request.id)?.status).toBe("SEARCHING");
  });
});
