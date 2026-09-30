import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRequest,
  enqueueJob,
  getJob,
  getRequest,
  insertUser,
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
import { claimAndRun } from "./dispatch.js";
import { DJ_SEARCH_SAMPLE, djSearchResponse } from "./dj-search.fixture.js";
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
    getSearch: async () => {
      order.push("get-search");
      return {
        id: "search-1",
        isComplete: true,
        responses: [
          {
            username: "peer",
            files: [{ filename: "track.flac", size: 12 }],
          },
        ],
      };
    },
    getSearchResponses: async () => {
      order.push("get-responses");
      return [];
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
    const alice = insertUser(db, { username: "Alice", passwordHash: "x", role: "operator" });
    const request = createRequest(db, { rawQuery: "Artist - Track", userId: alice.id });
    advance(db, request.id, "QUEUED", { artist: "Artist", title: "Track" });
    const job = enqueueJob(db, {
      type: "download",
      requestId: request.id,
      payload: { user: "peer", files: [{ filename: "track.flac", size: 12 }] },
    });
    const ctx: WorkerContext = {
      db,
      config,
      providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
      workerId: "worker-test",
    };
    await handleDownload(ctx, job);
    expect(order).toEqual(["list", "enqueue", "say"]);
    expect(say).toEqual([
      {
        text: "REQUEST_ACCEPTED. Requester: Alice. Track: Artist — Track. Acquisition has started.",
        kind: "dj-speak",
      },
    ]);
    expect(order).not.toContain("public-request");
    // A5: stay DOWNLOADING until correlated Completed+Succeeded + file exists.
    expect(getRequest(db, request.id)?.status).toBe("DOWNLOADING");
    const downloading = listRequestEvents(db, request.id).find((event) => event.to_status === "DOWNLOADING");
    expect(JSON.parse(downloading?.payload_json ?? "{}").event).toBe("REQUEST_ACCEPTED");
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

    // Search-only payload without a usable hit: no enqueue, no REQUEST_ACCEPTED, no false-complete.
    const emptySearch = {
      ...acquisition,
      getSearch: async () => {
        order.push("get-search");
        return { id: "only-search", isComplete: true, responses: [] };
      },
      getSearchResponses: async () => {
        order.push("get-responses");
        return [];
      },
    };
    const polled = enqueueJob(db, { type: "download", requestId: request.id, payload: { searchId: "only-search" } });
    await expect(
      handleDownload({ ...ctx, providers: { ...ctx.providers, acquisition: emptySearch } }, polled),
    ).rejects.toThrow(/no usable search result/);
    expect(getRequest(db, request.id)?.error).toBe("no usable search result");
    expect(getRequest(db, request.id)?.error).not.toContain("no_suitable_result");
    expect(say).toEqual([]);
    expect(order).toEqual(["get-search", "get-responses"]);
    expect(getRequest(db, request.id)?.status).toBe("FAILED");
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
      search: djSearchResponse([{ id: "song-1", title: "Track", artist: "Artist", album: "LP" }]),
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
    const radioPayload = JSON.parse(radioJob?.payload_json ?? "{}") as {
      filename?: string;
      track_ready?: boolean;
      search_wait_started_at?: number;
    };
    expect(radioPayload).toMatchObject({ filename: "track.mp3", track_ready: true });
    expect(typeof radioPayload.search_wait_started_at).toBe("number");
    expect(getRequest(db, request.id)?.status).toBe("IMPORTING");
    expect(existsSync(path.join(config.paths.library, "track.mp3"))).toBe(true);
    expect(existsSync(path.join(config.paths.staging, "track.mp3"))).toBe(false);
    expect(scanCalls).toEqual([]);
    expect(order).toEqual([]);

    const result = await handleQueueRadio(ctx, radioJob!);
    expect(order).toEqual(["search", "say", "queue"]);
    expect(say).toEqual([
      {
        text: "TRACK_READY. Track: Artist — Track. Track validated and available in library for airplay.",
        kind: "dj-speak",
      },
    ]);
    expect(queued).toEqual([{ id: "song-1", title: "Track", artist: "Artist", album: "LP" }]);
    expect(typeof (queued[0] as { id: unknown }).id).toBe("string");
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
      search: djSearchResponse([{ id: "song-9", title: "Blocked" }]),
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
      enqueueJob(db, {
        type: "queue_radio",
        requestId: request.id,
        payload: { track_ready: true, filename: "blocked.mp3" },
      }),
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

  it("keeps the original search-wait start and fails the request when the limit is reached", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { radio, library, acquisition, order, say } = harness({ search: { results: [] } });
    const request = createRequest(db, { rawQuery: "pending" });
    advance(db, request.id, "IMPORTING", { artist: "Artist", title: "Track" });
    const libraryFile = path.join(config.paths.library, "track.mp3");
    mkdirSync(config.paths.library, { recursive: true });
    writeFileSync(libraryFile, "kept-in-library");
    const started = Date.now() - 5_000;
    config.radio.search_visible_timeout_ms = 60_000;
    const ctx: WorkerContext = {
      db,
      config,
      providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
      workerId: "worker-test",
    };
    const job = enqueueJob(db, {
      type: "queue_radio",
      requestId: request.id,
      payload: { track_ready: true, filename: "track.mp3", search_wait_started_at: started },
    });
    const waiting = await handleQueueRadio(ctx, job);
    expect(waiting).toEqual({ waiting: true, reason: "not_search_visible" });
    expect(JSON.parse(getJob(db, job.id)?.payload_json ?? "{}").search_wait_started_at).toBe(started);
    const follow = listJobsForRequest(db, request.id).find((row) => row.id !== job.id);
    expect(JSON.parse(follow?.payload_json ?? "{}").search_wait_started_at).toBe(started);
    expect(say).toEqual([]);

    const again = await handleQueueRadio(ctx, follow!);
    expect(again).toEqual({ waiting: true, reason: "not_search_visible" });
    const third = listJobsForRequest(db, request.id).filter((row) => row.id !== job.id && row.id !== follow?.id);
    expect(third).toHaveLength(1);
    expect(JSON.parse(third[0]?.payload_json ?? "{}").search_wait_started_at).toBe(started);

    config.radio.search_visible_timeout_ms = 1_000;
    const expired = enqueueJob(db, {
      type: "queue_radio",
      requestId: request.id,
      payload: { track_ready: true, filename: "track.mp3", search_wait_started_at: Date.now() - 60_000 },
    });
    const failed = await handleQueueRadio(ctx, expired);
    expect(failed).toEqual({ failed: true, reason: "search_visible_timeout" });
    expect(getRequest(db, request.id)?.status).toBe("FAILED");
    expect(getRequest(db, request.id)?.error).toBe("search_visible_timeout");
    const failure = listRequestEvents(db, request.id).find((event) => event.to_status === "FAILED");
    expect(JSON.parse(failure?.payload_json ?? "{}")).toMatchObject({
      error: "search_visible_timeout",
      reason: "search_visible_timeout",
    });
    expect(failure?.payload_json ?? "").not.toContain("TRACK_READY");
    expect(say).toEqual([]);
    expect(order).toEqual(["search", "search"]);
    expect(order).not.toContain("enqueue");
    expect(order).not.toContain("acq-search");
    expect(readLibrary(libraryFile)).toBe("kept-in-library");
    const types = listJobsForRequest(db, request.id).map((row) => row.type);
    expect(types.every((type) => type === "queue_radio")).toBe(true);
  });

  it("fails the request as radio_unreachable after queue_radio retries, and keeps the library file", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { radio, library, acquisition, order, say } = harness();
    radio.djSearch = async () => {
      order.push("search");
      const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
      throw Object.assign(new TypeError("fetch failed"), { cause });
    };
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "IMPORTING", { artist: "Artist", title: "Track" });
    const libraryFile = path.join(config.paths.library, "track.mp3");
    mkdirSync(config.paths.library, { recursive: true });
    writeFileSync(libraryFile, "kept-in-library");
    const ctx: WorkerContext = {
      db,
      config,
      providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
      workerId: "worker-test",
    };
    const job = enqueueJob(db, {
      type: "queue_radio",
      requestId: request.id,
      payload: { track_ready: true, filename: "track.mp3", search_wait_started_at: Date.now() },
      maxAttempts: 2,
    });
    expect(await claimAndRun(ctx)).toBe(true);
    expect(getRequest(db, request.id)?.status).toBe("IMPORTING");
    expect(getRequest(db, request.id)?.error).toBeNull();
    expect(say).toEqual([]);
    db.prepare("UPDATE jobs SET run_after = ? WHERE id = ?").run(0, job.id);
    expect(await claimAndRun(ctx)).toBe(true);
    expect(getRequest(db, request.id)?.status).toBe("FAILED");
    expect(getRequest(db, request.id)?.error).toBe("radio_unreachable");
    const failure = listRequestEvents(db, request.id).find((event) => event.to_status === "FAILED");
    expect(JSON.parse(failure?.payload_json ?? "{}")).toMatchObject({
      error: "radio_unreachable",
      reason: "radio_unreachable",
    });
    expect(failure?.payload_json ?? "").not.toContain("TRACK_READY");
    expect(say).toEqual([]);
    expect(order).toEqual(["search", "search"]);
    expect(getJob(db, job.id)?.status).toBe("failed");
    expect(getJob(db, job.id)?.error).toBe("radio_unreachable");
    expect(readLibrary(libraryFile)).toBe("kept-in-library");
    const types = listJobsForRequest(db, request.id).map((row) => row.type);
    expect(types).toEqual(["queue_radio"]);
    expect(await claimAndRun(ctx)).toBe(false);
  });

  it("queues the search hit that matches the imported file, not the first hit", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const sample = DJ_SEARCH_SAMPLE.results[0]!;
    const { radio, library, acquisition, order, queued } = harness({
      search: djSearchResponse([
        { id: "other", title: "Other", artist: sample.artist, album: "Something Else" },
        sample,
      ]),
    });
    const request = createRequest(db, { rawQuery: `${sample.artist} - ${sample.title}` });
    advance(db, request.id, "IMPORTING", { artist: sample.artist, title: sample.title });
    const result = await handleQueueRadio(
      {
        db,
        config,
        providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
        workerId: "worker-test",
      },
      enqueueJob(db, {
        type: "queue_radio",
        requestId: request.id,
        payload: { track_ready: true, filename: "track.mp3", search_wait_started_at: Date.now() },
      }),
    );
    expect(result).toMatchObject({ queued: true, event: "TRACK_READY" });
    expect(queued).toEqual([sample]);
    expect(typeof (queued[0] as { id: unknown }).id).toBe("string");
    expect(order).toEqual(["search", "say", "queue"]);
  });

  it("fails handoff_no_match when no search hit is the imported file and does not queue", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const { radio, library, acquisition, order, say, queued } = harness({
      search: djSearchResponse([
        { id: "other", title: "Other", artist: "Artist", album: "LP" },
        { id: "also", title: "Track", artist: "Someone Else", album: "LP" },
      ]),
    });
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "IMPORTING", { artist: "Artist", title: "Track" });
    const libraryFile = path.join(config.paths.library, "track.mp3");
    mkdirSync(config.paths.library, { recursive: true });
    writeFileSync(libraryFile, "kept-in-library");
    config.radio.search_visible_timeout_ms = 60_000;
    const ctx: WorkerContext = {
      db,
      config,
      providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
      workerId: "worker-test",
    };
    const waiting = await handleQueueRadio(
      ctx,
      enqueueJob(db, {
        type: "queue_radio",
        requestId: request.id,
        payload: { track_ready: true, filename: "track.mp3", search_wait_started_at: Date.now() - 5_000 },
      }),
    );
    expect(waiting).toEqual({ waiting: true, reason: "not_search_visible" });
    expect(queued).toEqual([]);
    expect(say).toEqual([]);

    config.radio.search_visible_timeout_ms = 1_000;
    const follow = listJobsForRequest(db, request.id).at(-1)!;
    const failed = await handleQueueRadio(ctx, follow);
    expect(failed).toEqual({ failed: true, reason: "handoff_no_match" });
    expect(getRequest(db, request.id)?.error).toBe("handoff_no_match");
    expect(queued).toEqual([]);
    expect(say).toEqual([]);
    expect(order).toEqual(["search"]);
    expect(readLibrary(libraryFile)).toBe("kept-in-library");
  });
});

function readLibrary(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}
