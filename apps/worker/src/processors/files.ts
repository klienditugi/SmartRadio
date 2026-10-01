import fs from "node:fs";
import { fileVersionClass, type CandidateTrack, type VersionClass } from "@subwave-ai/core";
import { enqueueJob, getRequest, transitionRequest, updateJobPayload, type JobRow } from "@subwave-ai/db";
import { NeverPlayError, NotConfiguredError, ProviderHttpError } from "@subwave-ai/providers";
import { isAllowedAudioExtension, safeJoin } from "@subwave-ai/shared";
import type { JobHandler } from "../context.js";
import { FFPROBE_DURATION_TOLERANCE_SECONDS, probeMatchesExtension, runFfprobe } from "./ffprobe.js";
import { runIntegration } from "./guard.js";
import { failRequest, failureReasonCategory } from "./fail-request.js";
import { moveFileSync, removeEmptyChildDirectory } from "./move-file.js";
import { sayListenerFacts } from "./say-listener.js";

/** Wait for Navidrome’s passive scanner before the next /dj/search. Not a scan trigger. */
const TRACK_READY_POLL_MS = 15_000;

const RADIO_UNREACHABLE = "radio_unreachable";
const SEARCH_VISIBLE_TIMEOUT = "search_visible_timeout";
const HANDOFF_NO_MATCH = "handoff_no_match";
const HANDOFF_AMBIGUOUS = "handoff_ambiguous";

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

type VisibleTrack = { id: string; title: string; artist?: string; album?: string };

type FilePayload = {
  filename?: string;
  path?: string;
  size?: number;
  /** Selected search `length`, when the candidate had one. */
  duration_seconds?: number;
  /** Selector version class of the file that was downloaded. */
  version_class?: string;
};

type TrackReadyPayload = FilePayload & {
  track_ready?: boolean;
  search_wait_started_at?: number;
  /** Set once /dj/search returned string ids that were not the imported file. */
  handoff_unmatched?: boolean;
};

type SearchHit = VisibleTrack;

function radioQuery(request: { artist: string | null; title: string | null; raw_query: string }): string {
  return [request.artist, request.title].filter(Boolean).join(" ") || request.raw_query;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function expectedBytes(payload: { size?: unknown }): number | undefined {
  const size = finiteNumber(payload.size);
  return size !== undefined && size > 0 ? size : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `/dj/search` hits with a string id. Numeric ids are not treated as visible.
 * Only `id`, `title`, `artist`, and `album` are read. Those are the fields the
 * SUB/WAVE client and docs define. There is no path and no duration.
 */
function searchHits(search: unknown): SearchHit[] {
  if (!search || typeof search !== "object") return [];
  const results = (search as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const hits: SearchHit[] = [];
  for (const row of results) {
    if (!row || typeof row !== "object") continue;
    const item = row as { id?: unknown; title?: unknown; artist?: unknown; album?: unknown };
    if (typeof item.id !== "string" || item.id.length === 0) continue;
    if (typeof item.title !== "string" || item.title.length === 0) continue;
    hits.push({
      id: item.id,
      title: item.title,
      artist: optionalString(item.artist),
      album: optionalString(item.album),
    });
  }
  return hits;
}

/** First `/dj/search` hit with a string id. Library-hit playback still uses this. */
function visibleTrack(search: unknown): VisibleTrack | null {
  return searchHits(search)[0] ?? null;
}

const ACCEPTED_VERSION_LABELS = new Set([
  "original mix",
  "extended mix",
  "radio edit",
  "club mix",
  "remix",
  "album version",
]);

/** Lowercase, trim, collapse whitespace, and fold straight and curly apostrophes. */
function normalizeMatchText(value: string): string {
  return value.replaceAll("\u2018", "'").replaceAll("\u2019", "'").toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Exact normalized title, or that title plus one trailing ( ) or [ ] group
 * whose label is an accepted version. Not a substring or prefix match.
 */
function titlesMatch(requestTitle: string, hitTitle: string): boolean {
  const wanted = normalizeMatchText(requestTitle);
  const hit = normalizeMatchText(hitTitle);
  if (!wanted || !hit) return false;
  if (hit === wanted) return true;
  const opens = (hit.match(/\(/g) ?? []).length + (hit.match(/\[/g) ?? []).length;
  if (opens !== 1) return false;
  const round = hit.indexOf("(");
  const square = hit.indexOf("[");
  const useSquare = square !== -1 && (round === -1 || square < round);
  const openAt = useSquare ? square : round;
  const close = useSquare ? "]" : ")";
  if (openAt <= 0 || !hit.endsWith(close) || hit.indexOf(close) !== hit.length - 1) return false;
  const base = hit.slice(0, openAt).trim();
  const label = hit.slice(openAt + 1, -1).trim();
  if (base !== wanted) return false;
  return ACCEPTED_VERSION_LABELS.has(label);
}

type HandoffPick =
  | { kind: "match"; track: VisibleTrack }
  | { kind: "none" }
  | { kind: "ambiguous" };

function isVersionClass(value: string | undefined): value is VersionClass {
  return value === "remix" || value === "extended" || value === "original" || value === "radio_edit" || value === "other";
}

/**
 * Selector class of a search title. A bare title and Original Mix / Album
 * Version are `original`. Club Mix is `extended`. The names are the selector's.
 */
function hitVersionClass(title: string): VersionClass {
  const track: CandidateTrack = {
    peer: "handoff",
    path: title,
    basename: `${title}.mp3`,
    folders: [],
    sizeBytes: 1,
    format: { ext: ".mp3", lossless: false },
    locked: false,
  };
  return fileVersionClass(track);
}

/**
 * Every artist/title hit, then only those in the selected file's version class.
 * Exactly one may be queued. None or several is ambiguous. Not a file identity
 * match: the response has no path, and its string `id` is assigned after the scan.
 */
function matchImportedTrack(
  search: unknown,
  request: { artist: string | null; title: string | null },
  versionClass: string | undefined,
): HandoffPick {
  if (!request.title) return { kind: "none" };
  const wantedArtist = request.artist ? normalizeMatchText(request.artist) : "";
  const matches: VisibleTrack[] = [];
  for (const hit of searchHits(search)) {
    if (!titlesMatch(request.title, hit.title)) continue;
    if (wantedArtist && normalizeMatchText(hit.artist ?? "") !== wantedArtist) continue;
    matches.push(hit);
  }
  if (matches.length === 0) return { kind: "none" };
  if (!isVersionClass(versionClass)) return { kind: "ambiguous" };
  const sameClass = matches.filter((hit) => hitVersionClass(hit.title) === versionClass);
  if (sameClass.length === 1) return { kind: "match", track: sameClass[0]! };
  return { kind: "ambiguous" };
}

async function recordFailure(ctx: Parameters<JobHandler>[0], requestId: string, message: string): Promise<void> {
  await failRequest(ctx, {
    requestId,
    reason: failureReasonCategory(message),
    payload: { error: message, reason: message },
    patch: { error: message },
  });
}

async function fail(ctx: Parameters<JobHandler>[0], requestId: string, message: string): Promise<never> {
  await recordFailure(ctx, requestId, message);
  throw new Error(message);
}

async function moveInto(
  ctx: Parameters<JobHandler>[0],
  requestId: string,
  source: string,
  destination: string,
  expected: number | undefined,
  occupiedMessage: string,
): Promise<void> {
  if (fs.existsSync(destination)) {
    return await fail(ctx, requestId, occupiedMessage);
  }
  try {
    moveFileSync({ source, destination, expectedBytes: expected });
  } catch (err) {
    return await fail(ctx, requestId, (err as Error).message);
  }
}

/** Connection failure from SUB/WAVE. An HTTP response means the host answered. */
function isRadioUnreachable(err: unknown): boolean {
  if (err instanceof NotConfiguredError || err instanceof NeverPlayError || err instanceof ProviderHttpError) {
    return false;
  }
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    const message = current instanceof Error ? current.message : "";
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|unreachable/i.test(message)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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

  const payload: FilePayload = job.payload_json ? (JSON.parse(job.payload_json) as FilePayload) : {};
  // A5: never invent `{requestId}.bin` — require the real completed basename from acquisition.
  const filename = payload.filename;
  if (!filename || typeof filename !== "string") {
    return await fail(ctx, request.id, "validate_file missing real download basename");
  }
  if (!isAllowedAudioExtension(filename, ctx.config.files.allowed_extensions)) {
    return await fail(ctx, request.id, `disallowed extension for ${filename}`);
  }
  const source = safeJoin(ctx.config.paths.downloads, filename);
  if (!fs.existsSync(source)) {
    return await fail(ctx, request.id, `download missing: ${filename}`);
  }
  const stat = fs.statSync(source);
  if (stat.size <= 0 || stat.size > ctx.config.files.max_bytes) {
    return await fail(ctx, request.id, `invalid size ${stat.size}`);
  }
  const expected = expectedBytes(payload);
  if (expected !== undefined && stat.size !== expected) {
    return await fail(ctx, request.id, `size mismatch: source ${stat.size} bytes, expected ${expected}`);
  }
  const probe = await runFfprobe(ctx.config.files.ffprobe_path, source);
  if (probe === "unavailable") return await fail(ctx, request.id, "ffprobe_unavailable");
  if (probe === "failed") return await fail(ctx, request.id, "ffprobe_failed");
  if (!probeMatchesExtension(filename, probe)) return await fail(ctx, request.id, "ffprobe_format_mismatch");
  const expectedDuration = finiteNumber(payload.duration_seconds);
  if (expectedDuration === undefined || expectedDuration <= 0) {
    return await fail(ctx, request.id, "duration_unknown");
  }
  if (
    probe.durationSeconds === undefined ||
    Math.abs(probe.durationSeconds - expectedDuration) > FFPROBE_DURATION_TOLERANCE_SECONDS
  ) {
    return await fail(ctx, request.id, "ffprobe_duration_mismatch");
  }
  const dest = safeJoin(ctx.config.paths.staging, filename);
  await moveInto(ctx, request.id, source, dest, expected, `staging file already exists: ${filename}`);
  removeEmptyChildDirectory(ctx.config.paths.downloads, source);
  const importPayload: FilePayload = { filename };
  if (expected !== undefined) importPayload.size = expected;
  importPayload.duration_seconds = expectedDuration;
  if (payload.version_class) importPayload.version_class = payload.version_class;
  enqueueJob(ctx.db, { type: "import_library", requestId: request.id, payload: importPayload });
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

  const payload: FilePayload = job.payload_json ? (JSON.parse(job.payload_json) as FilePayload) : {};
  const filename = payload.filename;
  if (!filename || typeof filename !== "string") {
    return await fail(ctx, request.id, "import_library missing real download basename");
  }
  const source = safeJoin(ctx.config.paths.staging, filename);
  if (!fs.existsSync(source)) return await fail(ctx, request.id, "staging file missing");
  const expected = expectedBytes(payload);
  const dest = safeJoin(ctx.config.paths.library, filename);
  await moveInto(ctx, request.id, source, dest, expected, `library file already exists: ${filename}`);
  removeEmptyChildDirectory(ctx.config.paths.staging, source);
  // A4: Navidrome scans passively (~1 min). Do not enqueue index_library on this path.
  // queue_radio polls GET /dj/search, then POST /dj/queue-track, then says queued_coming_up.
  const queuePayload: TrackReadyPayload = { filename, track_ready: true, search_wait_started_at: Date.now() };
  const duration = finiteNumber(payload.duration_seconds);
  if (duration !== undefined && duration > 0) queuePayload.duration_seconds = duration;
  if (payload.version_class) queuePayload.version_class = payload.version_class;
  enqueueJob(ctx.db, {
    type: "queue_radio",
    requestId: request.id,
    payload: queuePayload,
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
  await runIntegration(ctx, request.id, () => ctx.providers.library.startScan());
  await runIntegration(ctx, request.id, () => ctx.providers.library.getScanStatus());
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
    await runIntegration(ctx, requestId, () =>
      ctx.providers.radio.queueTrack({
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
      }),
    );
  } catch (err) {
    if (err instanceof NeverPlayError) {
      await failRequest(ctx, {
        requestId,
        reason: "never_play",
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
  const ready = getRequest(ctx.db, requestId);
  if (ready) await sayListenerFacts(ctx, ready, { event: "queued_coming_up" });
  return { queued: true, track };
}

export const handleQueueRadio: JobHandler = async (ctx, job) => {
  if (!job.request_id) throw new Error("queue_radio job missing request_id");
  const request = getRequest(ctx.db, job.request_id);
  if (!request) throw new Error("request not found");
  const payload: TrackReadyPayload = job.payload_json ? (JSON.parse(job.payload_json) as TrackReadyPayload) : {};

  try {
    return await queueRadio(ctx, job, request, payload);
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      return await fail(ctx, request.id, err.message);
    }
    if (payload.track_ready === true && job.attempts >= job.max_attempts && isRadioUnreachable(err)) {
      const current = getRequest(ctx.db, request.id);
      if (
        current &&
        current.status !== "FAILED" &&
        current.status !== "CANCELLED" &&
        current.status !== "READY" &&
        current.status !== "REJECTED"
      ) {
        return await fail(ctx, request.id, RADIO_UNREACHABLE);
      }
    }
    throw err;
  }
};

function searchWaitTimedOut(started: number | undefined, timeoutMs: number, now = Date.now()): boolean {
  return started !== undefined && now - started >= timeoutMs;
}

async function queueRadio(
  ctx: Parameters<JobHandler>[0],
  job: JobRow,
  request: NonNullable<ReturnType<typeof getRequest>>,
  payload: TrackReadyPayload,
) {
  if (payload.track_ready === true) {
    if (request.status !== "IMPORTING") return { skipped: true, status: request.status };
    const timeoutMs = ctx.config.radio.search_visible_timeout_ms;
    const started = finiteNumber(payload.search_wait_started_at);
    if (searchWaitTimedOut(started, timeoutMs)) {
      const reason = payload.handoff_unmatched ? HANDOFF_NO_MATCH : SEARCH_VISIBLE_TIMEOUT;
      await recordFailure(ctx, request.id, reason);
      return { failed: true, reason };
    }
    const search = await runIntegration(ctx, request.id, () => ctx.providers.radio.djSearch(radioQuery(request)));
    const picked = matchImportedTrack(search, request, optionalString(payload.version_class));
    if (picked.kind === "ambiguous") {
      await recordFailure(ctx, request.id, HANDOFF_AMBIGUOUS);
      return { failed: true, reason: HANDOFF_AMBIGUOUS };
    }
    const track = picked.kind === "match" ? picked.track : null;
    if (!track) {
      const start = started ?? Date.now();
      const unmatched = searchHits(search).length > 0;
      if (searchWaitTimedOut(start, timeoutMs)) {
        const reason = unmatched ? HANDOFF_NO_MATCH : SEARCH_VISIBLE_TIMEOUT;
        await recordFailure(ctx, request.id, reason);
        return { failed: true, reason };
      }
      const nextPayload: TrackReadyPayload = {
        ...payload,
        track_ready: true,
        search_wait_started_at: start,
        ...(unmatched ? { handoff_unmatched: true } : {}),
      };
      if (!unmatched) delete nextPayload.handoff_unmatched;
      updateJobPayload(ctx.db, job.id, nextPayload);
      enqueueJob(ctx.db, {
        type: "queue_radio",
        requestId: request.id,
        payload: nextPayload,
        runAfter: Date.now() + TRACK_READY_POLL_MS,
      });
      return { waiting: true, reason: "not_search_visible" };
    }
    const queued = await queueVisibleTrack(ctx, request.id, track, "TRACK_READY");
    if (!queued.queued) return queued;
    return { ...queued, event: "TRACK_READY" as const };
  }

  if (request.status === "ALREADY_AVAILABLE") {
    transitionRequest(ctx.db, { requestId: request.id, to: "QUEUED", actor: ctx.workerId });
  }
  const current = getRequest(ctx.db, request.id)!;
  if (current.status !== "QUEUED") return { skipped: true, status: current.status };

  const search = await runIntegration(ctx, request.id, () => ctx.providers.radio.djSearch(radioQuery(current)));
  const track = visibleTrack(search);
  if (!track) {
    await failRequest(ctx, {
      requestId: request.id,
      reason: "no_radio_search_result",
      payload: { error: "no radio search result" },
      patch: { error: "no radio search result" },
    });
    return { queued: false };
  }
  return queueVisibleTrack(ctx, request.id, track);
}
