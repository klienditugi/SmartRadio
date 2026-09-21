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
import { NeverPlayError, UnverifiedAcquisitionProvider, type ProviderBundle, type SayRequest } from "@subwave-ai/providers";
import { loadConfig, type RequestStatus } from "@subwave-ai/shared";
import type { WorkerContext } from "./context.js";
import { handleDownload, handleSearchAcquisition } from "./processors/acquire.js";
import { handleImportLibrary, handleQueueRadio } from "./processors/files.js";

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-a4-"));
  const secrets = path.join(dir, "secrets");
  mkdirSync(secrets);
  writeFileSync(path.join(secrets, "admin_password"), "x");
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
  downloads: "${path.join(dir, "downloads")}"
  staging: "${path.join(dir, "staging")}"
  library: "${path.join(dir, "library")}"
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
  return { dir, config, db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function advance(
  db: ReturnType<typeof openDatabase>,
  id: string,
  to: RequestStatus,
  patch?: Partial<Pick<RequestRow, "artist" | "title">>,
): void {
  const viaLibrary: RequestStatus[] = ["CLASSIFYING", "APPROVED", "CHECKING_LIBRARY", "ALREADY_AVAILABLE"];
  const path = to === "ALREADY_AVAILABLE" ? viaLibrary : VIA_ACQUISITION;
  for (const status of path) {
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

function harness(opts?: {
  search?: unknown;
  queueError?: Error;
  acquisition?: ProviderBundle["acquisition"];
  scanCalls?: string[];
}) {
  const order: string[] = [];
  const say: SayRequest[] = [];
  const queued: unknown[] = [];
  const radio: ProviderBundle["radio"] = {
    kind: "subwave",
    verifyStatus: "verified",
    health: async () => ({ ok: true, verifyStatus: "verified", checked_at: "t" }),
    nowPlaying: async () => ({}),
    state: async () => ({}),
    djSearch: async () => {
      order.push("search");
      return opts?.search ?? { results: [] };
    },
    queueTrack: async (track) => {
      order.push("queue");
      queued.push(track);
      if (opts?.queueError) throw opts.queueError;
      return { ok: true };
    },
    refreshPlaylist: async () => ({}),
    say: async (input) => {
      order.push("say");
      say.push(input);
      return { ok: true, mode: "styled", kind: input.kind ?? "dj-speak", spoken: input.text };
    },
    publicRequest: async () => {
      order.push("public-request");
      return {};
    },
    publicRequestStatus: async () => ({}),
  };
  const library: ProviderBundle["library"] = {
    kind: "navidrome",
    verifyStatus: "verified",
    search3: async () => [],
    getSong: async () => null,
    startScan: async () => {
      opts?.scanCalls?.push("startScan");
      return {};
    },
    getScanStatus: async () => {
      opts?.scanCalls?.push("getScanStatus");
      return {};
    },
    health: async () => ({ ok: true, verifyStatus: "verified", checked_at: "t" }),
  };
  const acquisition: ProviderBundle["acquisition"] = opts?.acquisition ?? {
    kind: "slskd",
    verifyStatus: "verified",
    search: async () => {
      order.push("acq-search");
      return { id: "search-1" };
    },
    enqueueDownload: async () => {
      order.push("enqueue");
      return { ok: true };
    },
    listDownloads: async () => {
      order.push("list");
      return [];
    },
    health: async () => ({ ok: true, verifyStatus: "verified", checked_at: "t" }),
  };
  return { radio, library, acquisition, order, say, queued };
}

describe("A4 radio events", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it("announces REQUEST_ACCEPTED only after enqueueDownload accepts a transfer", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { radio, library, acquisition, order, say } = harness();
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "QUEUED", { artist: "Artist", title: "Track" });
    const job = enqueueJob(db, {
      type: "download",
      requestId: request.id,
      payload: { user: "peer", files: [{ filename: "track.flac" }] },
    });
    const ctx: WorkerContext = {
      db,
      config,
      providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
      workerId: "worker-test",
    };
    await handleDownload(ctx, job);
    expect(order).toEqual(["enqueue", "say", "list"]);
    expect(say).toEqual([
      { text: "Listener's requested song is coming: Artist — Track.", kind: "dj-speak" },
    ]);
    expect(order).not.toContain("public-request");
    expect(getRequest(db, request.id)?.status).toBe("DOWNLOAD_COMPLETE");
    const downloading = listRequestEvents(db, request.id).find((event) => event.to_status === "DOWNLOADING");
    expect(JSON.parse(downloading?.payload_json ?? "{}")).toEqual({ event: "REQUEST_ACCEPTED" });
  });

  it("does not announce when acquisition never starts", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const request = createRequest(db, { rawQuery: "missing song" });
    advance(db, request.id, "QUEUED");
    const { radio, library, acquisition, order, say } = harness();
    const ctx: WorkerContext = {
      db,
      config,
      providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
      workerId: "worker-test",
    };

    const unavailable = enqueueJob(db, { type: "download", requestId: request.id, payload: { user: "peer", files: [] } });
    await expect(
      handleDownload(
        {
          ...ctx,
          providers: { ...ctx.providers, acquisition: new UnverifiedAcquisitionProvider() },
        },
        unavailable,
      ),
    ).rejects.toThrow(/acquire_unavailable/);
    expect(getRequest(db, request.id)?.status).toBe("QUEUED");
    expect(say).toEqual([]);

    const polled = enqueueJob(db, { type: "download", requestId: request.id, payload: { searchId: "only-search" } });
    await handleDownload(ctx, polled);
    expect(say).toEqual([]);
    expect(order).toEqual(["list"]);
    expect(getRequest(db, request.id)?.status).toBe("DOWNLOAD_COMPLETE");
    const downloading = listRequestEvents(db, request.id).find((event) => event.to_status === "DOWNLOADING");
    expect(downloading?.payload_json).toBeNull();
  });

  it("does not announce REQUEST_ACCEPTED from search alone, and skips search when acquisition is unavailable", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { radio, library, acquisition, order, say } = harness();
    const request = createRequest(db, { rawQuery: "search only" });
    advance(db, request.id, "SEARCHING");
    const ctx: WorkerContext = {
      db,
      config,
      providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
      workerId: "worker-test",
    };
    await handleSearchAcquisition(ctx, enqueueJob(db, { type: "search_acquisition", requestId: request.id }));
    expect(order).toEqual(["acq-search"]);
    expect(say).toEqual([]);
    expect(getRequest(db, request.id)?.status).toBe("QUEUED");

    const other = createRequest(db, { rawQuery: "no daemon" });
    advance(db, other.id, "SEARCHING");
    await expect(
      handleSearchAcquisition(
        {
          ...ctx,
          providers: {
            ...ctx.providers,
            acquisition: new UnverifiedAcquisitionProvider(),
          },
        },
        enqueueJob(db, { type: "search_acquisition", requestId: other.id }),
      ),
    ).rejects.toThrow(/acquire_unavailable/);
    expect(getRequest(db, other.id)?.status).toBe("SEARCHING");
    expect(say).toEqual([]);
  });

  it("imports into the library, then says TRACK_READY only after search can see a string id, then queues", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const scanCalls: string[] = [];
    const { radio, library, acquisition, order, say, queued } = harness({
      search: { results: [{ id: "song-1", title: "Track", artist: "Artist", album: "LP" }] },
      scanCalls,
    });
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "VALIDATING", { artist: "Artist", title: "Track" });
    mkdirSync(config.paths.staging, { recursive: true });
    writeFileSync(path.join(config.paths.staging, "track.mp3"), "audio");
    const ctx: WorkerContext = {
      db,
      config,
      providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
      workerId: "worker-test",
    };
    await handleImportLibrary(
      ctx,
      enqueueJob(db, { type: "import_library", requestId: request.id, payload: { filename: "track.mp3" } }),
    );
    const jobs = listJobsForRequest(db, request.id);
    expect(jobs.map((job) => job.type).sort()).toEqual(["import_library", "queue_radio"]);
    const radioJob = jobs.find((job) => job.type === "queue_radio");
    expect(JSON.parse(radioJob?.payload_json ?? "{}")).toEqual({ filename: "track.mp3", track_ready: true });
    expect(getRequest(db, request.id)?.status).toBe("IMPORTING");
    expect(scanCalls).toEqual([]);

    const result = await handleQueueRadio(ctx, radioJob!);
    expect(order).toEqual(["search", "say", "queue"]);
    expect(say).toEqual([{ text: "Listener's requested song is ready: Artist — Track.", kind: "dj-speak" }]);
    expect(queued).toEqual([{ id: "song-1", title: "Track", artist: "Artist", album: "LP" }]);
    expect(result).toMatchObject({ queued: true, event: "TRACK_READY" });
    expect(getRequest(db, request.id)?.status).toBe("READY");
    const ready = listRequestEvents(db, request.id).find((event) => event.to_status === "READY");
    expect(JSON.parse(ready?.payload_json ?? "{}").event).toBe("TRACK_READY");
    expect(scanCalls).toEqual([]);
  });

  it("waits without saying when /dj/search has no string id", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { radio, library, acquisition, order, say } = harness({
      search: { results: [{ id: 99, title: "Not a string id" }] },
    });
    const request = createRequest(db, { rawQuery: "pending" });
    advance(db, request.id, "IMPORTING");
    const job = enqueueJob(db, {
      type: "queue_radio",
      requestId: request.id,
      payload: { track_ready: true, filename: "track.mp3" },
    });
    const result = await handleQueueRadio(
      {
        db,
        config,
        providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
        workerId: "worker-test",
      },
      job,
    );
    expect(result).toEqual({ waiting: true, reason: "not_search_visible" });
    expect(order).toEqual(["search"]);
    expect(say).toEqual([]);
    expect(getRequest(db, request.id)?.status).toBe("IMPORTING");
    const followUps = listJobsForRequest(db, request.id).filter((row) => row.id !== job.id);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.type).toBe("queue_radio");
    expect(followUps[0]?.run_after).toBeGreaterThan(Date.now());
    expect(JSON.parse(followUps[0]?.payload_json ?? "{}").track_ready).toBe(true);
  });

  it("records never-play when queue-track returns 409 after TRACK_READY", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { radio, library, acquisition, order } = harness({
      search: { results: [{ id: "song-9", title: "Blocked" }] },
      queueError: new NeverPlayError("blocked"),
    });
    const request = createRequest(db, { rawQuery: "blocked" });
    advance(db, request.id, "IMPORTING", { title: "Blocked" });
    const result = await handleQueueRadio(
      {
        db,
        config,
        providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
        workerId: "worker-test",
      },
      enqueueJob(db, { type: "queue_radio", requestId: request.id, payload: { track_ready: true } }),
    );
    expect(order).toEqual(["search", "say", "queue"]);
    expect(result).toEqual({ queued: false, never_play: true });
    expect(getRequest(db, request.id)?.status).toBe("FAILED");
    expect(getRequest(db, request.id)?.error).toBe("never-play");
  });

  it("keeps the library-hit handoff on search then queue-track without TRACK_READY", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { radio, library, acquisition, order, say, queued } = harness({
      search: { results: [{ id: "already", title: "Known", artist: "Act" }] },
    });
    const request = createRequest(db, { rawQuery: "Act - Known" });
    advance(db, request.id, "ALREADY_AVAILABLE");
    await handleQueueRadio(
      {
        db,
        config,
        providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
        workerId: "worker-test",
      },
      enqueueJob(db, { type: "queue_radio", requestId: request.id }),
    );
    expect(order).toEqual(["search", "queue"]);
    expect(say).toEqual([]);
    expect(queued).toEqual([{ id: "already", title: "Known", artist: "Act", album: undefined }]);
    expect(getRequest(db, request.id)?.status).toBe("READY");
  });
});
