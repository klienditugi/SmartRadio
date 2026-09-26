import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRequest,
  enqueueJob,
  getRequest,
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

const HIT = {
  username: "peer-a",
  id: "resp-a",
  files: [{ filename: "\\\\music\\\\track.flac", size: 100, extension: "flac", id: 7 }],
};

describe("A5 acquisition worker", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
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
    setTransfers([
      {
        username: "peer-a",
        filename: "\\\\music\\\\track.flac",
        size: 100,
        state: "InProgress",
        percentComplete: 10,
      },
    ]);

    const enq = await handleDownload(
      ctx,
      enqueueJob(db, { type: "download", requestId: request.id, payload: { searchId: "search-1" } }),
    );
    expect(enq).toMatchObject({ enqueued: true });
    expect(enqueued).toEqual([{ user: "peer-a", files: [{ filename: "\\\\music\\\\track.flac", size: 100 }] }]);
    expect(order).toContain("enqueue");
    expect(order).toContain("say");
    expect(say[0]?.text).toContain("REQUEST_ACCEPTED");
    expect(getRequest(db, request.id)?.status).toBe("DOWNLOADING");
    const accepted = listRequestEvents(db, request.id).find((event) => event.to_status === "DOWNLOADING");
    expect(JSON.parse(accepted?.payload_json ?? "{}").event).toBe("REQUEST_ACCEPTED");

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
    writeFileSync(path.join(downloads, "track.flac"), Buffer.alloc(100));
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
          selected: { username: "peer-a", filename: "\\\\music\\\\track.flac", size: 100, fileId: "7" },
        },
      }),
    );
    expect(result).toMatchObject({ completed: true, basename: "track.flac" });
    expect(getRequest(db, request.id)?.status).toBe("DOWNLOAD_COMPLETE");
    expect(order).toEqual(["list"]);
    const validate = listJobsForRequest(db, request.id).find((job) => job.type === "validate_file");
    expect(JSON.parse(validate?.payload_json ?? "{}")).toEqual({
      filename: "track.flac",
      path: path.join(downloads, "track.flac"),
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
    await expect(
      handleDownload(
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
      ),
    ).rejects.toThrow(/errored/i);
    expect(getRequest(db, request.id)?.status).toBe("FAILED");
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
    await expect(
      handleDownload(
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
      ),
    ).rejects.toThrow(/download missing/);
    expect(getRequest(db, request.id)?.status).toBe("FAILED");
  });

  it("enqueues the clean file unless the request title asks for the remix", async () => {
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
      await handleDownload(
        {
          db,
          config,
          providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
          workerId: "worker-test",
        },
        enqueueJob(db, { type: "download", requestId: request.id, payload: { searchId: "search-1" } }),
      );
      return enqueued;
    }

    expect(await chosen("Get Lucky")).toEqual([{ user: "album-peer", files: [{ filename: album, size: 40_000_000 }] }]);
    expect(await chosen("Get Lucky Remix")).toEqual([
      { user: "remix-peer", files: [{ filename: remix, size: 30_000_000 }] },
    ]);
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
