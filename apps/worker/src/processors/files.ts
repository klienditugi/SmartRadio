import fs from "node:fs";
import { enqueueJob, getRequest, transitionRequest } from "@subwave-ai/db";
import { assertInsideRoot, isAllowedAudioExtension, safeJoin } from "@subwave-ai/shared";
import type { JobHandler } from "../context.js";

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
  enqueueJob(ctx.db, { type: "index_library", requestId: request.id, payload: { filename } });
  return { library: dest };
};

export const handleIndexLibrary: JobHandler = async (ctx, job) => {
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

export const handleQueueRadio: JobHandler = async (ctx, job) => {
  if (!job.request_id) throw new Error("queue_radio job missing request_id");
  const request = getRequest(ctx.db, job.request_id);
  if (!request) throw new Error("request not found");
  if (request.status === "ALREADY_AVAILABLE") {
    transitionRequest(ctx.db, { requestId: request.id, to: "QUEUED", actor: ctx.workerId });
  }
  const current = getRequest(ctx.db, request.id)!;
  if (current.status !== "QUEUED") return { skipped: true, status: current.status };

  const query = [current.artist, current.title].filter(Boolean).join(" ") || current.raw_query;
  const search = (await ctx.providers.radio.djSearch(query)) as {
    results?: Array<{ id: string; title: string; artist?: string }>;
  };
  const track = search.results?.[0];
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
  await ctx.providers.radio.queueTrack({ id: String(track.id), title: track.title, artist: track.artist });
  transitionRequest(ctx.db, { requestId: request.id, to: "READY", actor: ctx.workerId, payload: { track } });
  return { queued: true, track };
};
