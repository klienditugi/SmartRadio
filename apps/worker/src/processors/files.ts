import fs from "node:fs";
import { enqueueJob, getRequest, transitionRequest } from "@subwave-ai/db";
import { NeverPlayError } from "@subwave-ai/providers";
import { assertInsideRoot, isAllowedAudioExtension, safeJoin } from "@subwave-ai/shared";
import type { JobHandler } from "../context.js";
import { trackReadyContext } from "./notify.js";

/** Wait for Navidrome’s passive scanner before the next /dj/search. Not a scan trigger. */
const TRACK_READY_POLL_MS = 15_000;

type VisibleTrack = { id: string; title: string; artist?: string; album?: string };

function radioQuery(request: { artist: string | null; title: string | null; raw_query: string }): string {
  return [request.artist, request.title].filter(Boolean).join(" ") || request.raw_query;
}

/** First `/dj/search` hit with a string id. Numeric ids are not treated as visible. */
function visibleTrack(search: unknown): VisibleTrack | null {
  if (!search || typeof search !== "object") return null;
  const results = (search as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  for (const row of results) {
    if (!row || typeof row !== "object") continue;
    const item = row as { id?: unknown; title?: unknown; artist?: unknown; album?: unknown };
    if (typeof item.id !== "string" || item.id.length === 0) continue;
    if (typeof item.title !== "string" || item.title.length === 0) continue;
    return {
      id: item.id,
      title: item.title,
      artist: typeof item.artist === "string" ? item.artist : undefined,
      album: typeof item.album === "string" ? item.album : undefined,
    };
  }
  return null;
}

function fail(ctx: Parameters<JobHandler>[0], requestId: string, message: string): never {
  transitionRequest(ctx.db, {
    requestId,
    to: "FAILED",
    actor: ctx.workerId,
    payload: { error: message },
    patch: { error: message },
  });
  throw new Error(message);
}

export const handleValidateFile: JobHandler = async (ctx, job) => {
  if (!job.request_id) throw new Error("validate_file job missing request_id");
  const request = getRequest(ctx.db, job.request_id);
  if (!request) throw new Error("request not found");
  if (request.status === "DOWNLOAD_COMPLETE") {
    transitionRequest(ctx.db, { requestId: request.id, to: "VALIDATING", actor: ctx.workerId });
  }
  const current = getRequest(ctx.db, request.id)!;
  if (current.status !== "VALIDATING") return { skipped: true, status: current.status };

  const payload = job.payload_json ? (JSON.parse(job.payload_json) as { filename?: string }) : {};
  const filename = payload.filename ?? `${request.id}.bin`;
  if (!isAllowedAudioExtension(filename, ctx.config.files.allowed_extensions)) {
    fail(ctx, request.id, `disallowed extension for ${filename}`);
  }
  const source = safeJoin(ctx.config.paths.downloads, filename);
  if (!fs.existsSync(source)) {
    fail(ctx, request.id, `download missing: ${filename}`);
  }
  const stat = fs.statSync(source);
  if (stat.size <= 0 || stat.size > ctx.config.files.max_bytes) {
    fail(ctx, request.id, `invalid size ${stat.size}`);
  }
  fs.mkdirSync(ctx.config.paths.staging, { recursive: true });
  const dest = safeJoin(ctx.config.paths.staging, filename);
  fs.copyFileSync(source, dest);
  enqueueJob(ctx.db, { type: "import_library", requestId: request.id, payload: { filename } });
  return { staging: dest };
};

export const handleImportLibrary: JobHandler = async (ctx, job) => {
  if (!job.request_id) throw new Error("import_library job missing request_id");
  const request = getRequest(ctx.db, job.request_id);
  if (!request) throw new Error("request not found");
  if (request.status === "VALIDATING") {
    transitionRequest(ctx.db, { requestId: request.id, to: "IMPORTING", actor: ctx.workerId });
  }
  const current = getRequest(ctx.db, request.id)!;
  if (current.status !== "IMPORTING") return { skipped: true, status: current.status };

  const payload = job.payload_json ? (JSON.parse(job.payload_json) as { filename?: string }) : {};
  const filename = payload.filename ?? `${request.id}.bin`;
  const source = safeJoin(ctx.config.paths.staging, filename);
  assertInsideRoot(ctx.config.paths.staging, source);
  if (!fs.existsSync(source)) fail(ctx, request.id, "staging file missing");
  fs.mkdirSync(ctx.config.paths.library, { recursive: true });
  const dest = safeJoin(ctx.config.paths.library, filename);
  fs.copyFileSync(source, dest);
  // A4: Navidrome scans passively (~1 min). Do not enqueue index_library on this path.
  // queue_radio polls GET /dj/search, then say(TRACK_READY), then POST /dj/queue-track.
  enqueueJob(ctx.db, {
    type: "queue_radio",
    requestId: request.id,
    payload: { filename, track_ready: true },
  });
  return { library: dest };
};

export const handleIndexLibrary: JobHandler = async (ctx, job) => {
  // Ops-only. The import happy path does not enqueue this job.
  // Standalone admin scan (no request_id) — Navidrome startScan/getScanStatus only.
  if (!job.request_id) {
    await ctx.providers.library.startScan();
    const status = await ctx.providers.library.getScanStatus();
    return { indexed: true, standalone: true, scan: status };
  }
  const request = getRequest(ctx.db, job.request_id);
  if (!request) throw new Error("request not found");
  if (request.status === "IMPORTING") {
    transitionRequest(ctx.db, { requestId: request.id, to: "INDEXING", actor: ctx.workerId });
  }
  const current = getRequest(ctx.db, request.id)!;
  if (current.status !== "INDEXING") return { skipped: true, status: current.status };
  await ctx.providers.library.startScan();
  await ctx.providers.library.getScanStatus();
  transitionRequest(ctx.db, { requestId: request.id, to: "READY", actor: ctx.workerId });
  return { indexed: true };
};

export const handleRefreshPlaylist: JobHandler = async (ctx) => {
  const result = await ctx.providers.radio.refreshPlaylist();
  return { refreshed: true, result };
};

async function queueVisibleTrack(
  ctx: Parameters<JobHandler>[0],
  requestId: string,
  track: VisibleTrack,
  event?: "TRACK_READY",
): Promise<{ queued: true; track: VisibleTrack } | { queued: false; never_play: true }> {
  try {
    await ctx.providers.radio.queueTrack({
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
    });
  } catch (err) {
    if (err instanceof NeverPlayError) {
      transitionRequest(ctx.db, {
        requestId,
        to: "FAILED",
        actor: ctx.workerId,
        payload: { never_play: true, error: "never-play" },
        patch: { error: "never-play" },
      });
      return { queued: false, never_play: true };
    }
    throw err;
  }
  transitionRequest(ctx.db, {
    requestId,
    to: "READY",
    actor: ctx.workerId,
    payload: event ? { event, track } : { track },
  });
  return { queued: true, track };
}

export const handleQueueRadio: JobHandler = async (ctx, job) => {
  if (!job.request_id) throw new Error("queue_radio job missing request_id");
  const request = getRequest(ctx.db, job.request_id);
  if (!request) throw new Error("request not found");
  const payload = job.payload_json ? (JSON.parse(job.payload_json) as { track_ready?: boolean }) : {};

  if (payload.track_ready === true) {
    if (request.status !== "IMPORTING") return { skipped: true, status: request.status };
    const search = await ctx.providers.radio.djSearch(radioQuery(request));
    const track = visibleTrack(search);
    if (!track) {
      enqueueJob(ctx.db, {
        type: "queue_radio",
        requestId: request.id,
        payload,
        runAfter: Date.now() + TRACK_READY_POLL_MS,
      });
      return { waiting: true, reason: "not_search_visible" };
    }
    await ctx.providers.radio.say({
      text: trackReadyContext(request),
      kind: "dj-speak",
    });
    const queued = await queueVisibleTrack(ctx, request.id, track, "TRACK_READY");
    if (!queued.queued) return queued;
    return { ...queued, event: "TRACK_READY" as const };
  }

  if (request.status === "ALREADY_AVAILABLE") {
    transitionRequest(ctx.db, { requestId: request.id, to: "QUEUED", actor: ctx.workerId });
  }
  const current = getRequest(ctx.db, request.id)!;
  if (current.status !== "QUEUED") return { skipped: true, status: current.status };

  const search = await ctx.providers.radio.djSearch(radioQuery(current));
  const track = visibleTrack(search);
  if (!track) {
    transitionRequest(ctx.db, {
      requestId: request.id,
      to: "FAILED",
      actor: ctx.workerId,
      payload: { error: "no radio search result" },
      patch: { error: "no radio search result" },
    });
    return { queued: false };
  }
  return queueVisibleTrack(ctx, request.id, track);
};
