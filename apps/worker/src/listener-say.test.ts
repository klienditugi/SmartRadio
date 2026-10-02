import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequest, enqueueJob, getRequest, openDatabase, transitionRequest } from "@subwave-ai/db";
import { NeverPlayError, SubWaveProvider, type ProviderBundle, type SayRequest } from "@subwave-ai/providers";
import { loadConfig, type RequestStatus } from "@subwave-ai/shared";
import type { WorkerContext } from "./context.js";
import { handleCheckLibrary } from "./processors/library.js";
import { handleQueueRadio } from "./processors/files.js";
import { failRequest, failureReasonCategory } from "./processors/fail-request.js";

const TO_IMPORTING: RequestStatus[] = [
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-say-"));
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
`,
  );
  const config = loadConfig({ configPath: cfgPath });
  const db = openDatabase(":memory:");
  const say: SayRequest[] = [];
  const queued: unknown[] = [];
  let sayError: Error | null = null;
  const radio: ProviderBundle["radio"] = {
    kind: "subwave",
    verifyStatus: "verified",
    health: async () => ({ ok: true, verifyStatus: "verified", checked_at: "t" }),
    nowPlaying: async () => ({}),
    state: async () => ({}),
    djSearch: async () => ({ results: [] }),
    queueTrack: async (track) => {
      queued.push(track);
      return { ok: true };
    },
    refreshPlaylist: async () => ({}),
    say: async (input) => {
      say.push(input);
      if (sayError) throw sayError;
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
  const acquisition: ProviderBundle["acquisition"] = {
    kind: "slskd",
    verifyStatus: "verified",
    search: async () => ({}),
    getSearch: async () => ({}),
    getSearchResponses: async () => [],
    enqueueDownload: async () => ({}),
    listDownloads: async () => [],
    health: async () => ({ ok: true, verifyStatus: "verified", checked_at: "t" }),
  };
  const ctx: WorkerContext = {
    db,
    config,
    providers: { llm: {} as ProviderBundle["llm"], library, radio, acquisition },
    workerId: "worker-test",
  };
  return {
    ctx,
    db,
    say,
    queued,
    radio,
    library,
    setSayError(error: Error | null) {
      sayError = error;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function advance(db: ReturnType<typeof openDatabase>, id: string, to: RequestStatus, artist = "Artist", title = "Track"): void {
  const viaApproved: RequestStatus[] = ["CLASSIFYING", "APPROVED"];
  const statuses = to === "APPROVED" ? viaApproved : TO_IMPORTING;
  for (const status of statuses) {
    transitionRequest(db, {
      requestId: id,
      to: status,
      actor: "test",
      patch: status === "APPROVED" ? { artist, title } : undefined,
    });
    if (status === to) return;
  }
  throw new Error(`unreachable status ${to}`);
}

describe("listener say facts", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it("sends request_received after classification, including a library hit", async () => {
    const { ctx, db, say, cleanup } = fixture();
    cleanups.push(cleanup);
    ctx.providers.library.search3 = async () => [{ id: "lib-1", title: "Track", artist: "Artist" }];
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "APPROVED");
    await handleCheckLibrary(ctx, enqueueJob(db, { type: "check_library", requestId: request.id }));
    expect(getRequest(db, request.id)?.status).toBe("ALREADY_AVAILABLE");
    expect(say).toEqual([
      {
        text: "event: request_received\ntrack: Artist - Track",
        kind: "dj-speak",
      },
    ]);
    expect(say[0]?.text).not.toMatch(/[.!?] /);
  });

  it("sends one request_received across a retry after a failed send", async () => {
    const { ctx, db, say, cleanup, setSayError } = fixture();
    cleanups.push(cleanup);
    setSayError(new TypeError("fetch failed"));
    ctx.providers.library.search3 = async () => {
      throw new Error("temporary");
    };
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "APPROVED");
    const job = enqueueJob(db, { type: "check_library", requestId: request.id });
    await expect(handleCheckLibrary(ctx, job)).rejects.toThrow(/temporary/);
    expect(getRequest(db, request.id)?.status).toBe("CHECKING_LIBRARY");
    expect(say).toHaveLength(1);
    expect(say[0]?.text.startsWith("event: request_received")).toBe(true);
    await expect(handleCheckLibrary(ctx, job)).rejects.toThrow(/temporary/);
    expect(say).toHaveLength(1);
    const claims = db
      .prepare(`SELECT event FROM listener_say_events WHERE request_id = ?`)
      .all(request.id) as Array<{ event: string }>;
    expect(claims.map((row) => row.event)).toEqual(["request_received"]);
  });

  it("sends queued_coming_up only after queueTrack, and never-play facts on 409", async () => {
    const { ctx, db, say, queued, radio, cleanup } = fixture();
    cleanups.push(cleanup);
    radio.djSearch = async () => ({ results: [{ id: "song-1", title: "Track", artist: "Artist" }] });
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "IMPORTING");
    const queuedResult = await handleQueueRadio(
      ctx,
      enqueueJob(db, {
        type: "queue_radio",
        requestId: request.id,
        payload: { track_ready: true, filename: "track.mp3", version_class: "original", search_wait_started_at: Date.now() },
      }),
    );
    expect(queuedResult).toMatchObject({ queued: true, event: "TRACK_READY" });
    expect(queued).toEqual([{ id: "song-1", title: "Track", artist: "Artist", album: undefined }]);
    expect(say.map((item) => item.text)).toEqual(["event: queued_coming_up\ntrack: Artist - Track"]);
    expect(getRequest(db, request.id)?.status).toBe("READY");

    say.length = 0;
    queued.length = 0;
    radio.queueTrack = async (track) => {
      queued.push(track);
      throw new NeverPlayError("blocked");
    };
    const blocked = createRequest(db, { rawQuery: "Artist - Blocked" });
    advance(db, blocked.id, "IMPORTING", "Artist", "Blocked");
    radio.djSearch = async () => ({ results: [{ id: "song-9", title: "Blocked", artist: "Artist" }] });
    const failed = await handleQueueRadio(
      ctx,
      enqueueJob(db, {
        type: "queue_radio",
        requestId: blocked.id,
        payload: { track_ready: true, filename: "blocked.mp3", version_class: "original", search_wait_started_at: Date.now() },
      }),
    );
    expect(failed).toEqual({ queued: false, never_play: true });
    expect(getRequest(db, blocked.id)?.status).toBe("FAILED");
    expect(getRequest(db, blocked.id)?.error).toBe("never-play");
    expect(say.map((item) => item.text)).toEqual(["event: request_failed\ntrack: Artist - Blocked\nreason: never_play"]);
    expect(say.some((item) => item.text.includes("queued_coming_up"))).toBe(false);
  });

  it("sends request_failed facts for several stable reasons and not the raw error", async () => {
    const { ctx, db, say, cleanup } = fixture();
    cleanups.push(cleanup);
    const reasons = [
      "no_suitable_result",
      "selected_missing_length",
      "enqueue_failed",
      "download_timeout",
      "transfer_not_found",
      "download_not_found",
      "duration_unknown",
      "ffprobe_unavailable",
      "handoff_no_match",
      "handoff_ambiguous",
      "search_visible_timeout",
      "radio_unreachable",
      "never_play",
    ];
    for (const reason of reasons) {
      const request = createRequest(db, { rawQuery: `Artist - ${reason}` });
      await failRequest(ctx, {
        requestId: request.id,
        reason,
        payload: { error: reason, reason },
        patch: { error: reason },
      });
      expect(getRequest(db, request.id)?.status).toBe("FAILED");
    }
    expect(say.map((item) => item.text)).toEqual(
      reasons.map((reason) => `event: request_failed\ntrack: Artist - ${reason}\nreason: ${reason}`),
    );

    const noisy = "download_not_found: tried /music/downloads/peer-user/secret.flac";
    expect(failureReasonCategory(noisy)).toBe("download_not_found");
    expect(failureReasonCategory("no_suitable_result: locked=2, title_mismatch=3")).toBe("no_suitable_result");
    expect(failureReasonCategory("Completed, TimedOut")).toBe("Completed, TimedOut");
    expect(failureReasonCategory("ECONNREFUSED peer-user /music/secret.flac")).toBe("request_failed");
    const request = createRequest(db, { rawQuery: "Artist - Title" });
    await failRequest(ctx, {
      requestId: request.id,
      reason: failureReasonCategory(noisy),
      payload: { error: noisy, reason: noisy },
      patch: { error: noisy },
    });
    const text = say.at(-1)?.text ?? "";
    expect(text).toBe("event: request_failed\ntrack: Artist - Title\nreason: download_not_found");
    expect(text).not.toContain("secret.flac");
    expect(text).not.toContain("/music/");
    expect(text).not.toContain("peer-user");
    expect(text).not.toContain(request.id);
    expect(getRequest(db, request.id)?.error).toBe(noisy);
  });

  it("does not let a throwing say block queueTrack, READY, or a FAILED transition", async () => {
    const { ctx, db, say, queued, radio, cleanup, setSayError } = fixture();
    cleanups.push(cleanup);
    setSayError(new TypeError("fetch failed"));
    radio.djSearch = async () => ({ results: [{ id: "song-1", title: "Track", artist: "Artist" }] });
    const readyRequest = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, readyRequest.id, "IMPORTING");
    const ready = await handleQueueRadio(
      ctx,
      enqueueJob(db, {
        type: "queue_radio",
        requestId: readyRequest.id,
        payload: { track_ready: true, filename: "track.mp3", version_class: "original", search_wait_started_at: Date.now() },
      }),
    );
    expect(ready).toMatchObject({ queued: true, event: "TRACK_READY" });
    expect(queued).toHaveLength(1);
    expect(getRequest(db, readyRequest.id)?.status).toBe("READY");
    expect(say).toHaveLength(1);

    const failedRequest = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, failedRequest.id, "IMPORTING");
    ctx.config.radio.search_visible_timeout_ms = 1_000;
    const failed = await handleQueueRadio(
      ctx,
      enqueueJob(db, {
        type: "queue_radio",
        requestId: failedRequest.id,
        payload: { track_ready: true, filename: "track.mp3", search_wait_started_at: Date.now() - 60_000 },
      }),
    );
    expect(failed).toEqual({ failed: true, reason: "search_visible_timeout" });
    expect(getRequest(db, failedRequest.id)?.status).toBe("FAILED");
    expect(getRequest(db, failedRequest.id)?.error).toBe("search_visible_timeout");
    expect(say).toHaveLength(2);
    expect(queued).toHaveLength(1);
  });

  it("logs and swallows an HTTP 500 from say and still reaches READY", async () => {
    const { ctx, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const sayBodies: Array<Record<string, unknown>> = [];
    ctx.providers.radio = new SubWaveProvider({
      baseUrl: "http://radio.test/api",
      adminUser: "dj",
      adminPassword: "x",
      verifyStatus: "verified",
      fetch: async (url, init) => {
        const href = String(url);
        if (href.includes("/dj/say")) {
          sayBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response("llm failed", { status: 500 });
        }
        if (href.includes("/dj/queue-track")) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ results: [{ id: "song-1", title: "Track", artist: "Artist" }], ok: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((part) => String(part)).join(" "));
    });
    try {
      const request = createRequest(db, { rawQuery: "Artist - Track" });
      advance(db, request.id, "IMPORTING");
      const result = await handleQueueRadio(
        ctx,
        enqueueJob(db, {
          type: "queue_radio",
          requestId: request.id,
          payload: {
            track_ready: true,
            filename: "track.mp3",
            version_class: "original",
            search_wait_started_at: Date.now(),
          },
        }),
      );
      expect(result).toMatchObject({ queued: true, event: "TRACK_READY" });
      expect(getRequest(db, request.id)?.status).toBe("READY");
      expect(sayBodies).toEqual([
        {
          text: "event: queued_coming_up\ntrack: Artist - Track",
          mode: "styled",
          kind: "dj-speak",
        },
      ]);
      expect(errors.some((line) => line.includes("listener say failed") && line.includes("500"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
