import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  enqueueJob,
  getRequest,
  insertAcquisitionItem,
  listAcquisitionItems,
  transitionRequest,
  updateAcquisitionItem,
  updateJobPayload,
  type AcquisitionItemRow,
} from "@subwave-ai/db";
import {
  findCorrelatedTransfer,
  isSearchComplete,
  isTransferSucceeded,
  isTransferTerminalFailure,
  observedTransferId,
  resolveDownloadedFile,
  selectSearch,
  type AcquisitionProvider,
  type SelectedSearchFile,
} from "@subwave-ai/providers";
import type { JobHandler } from "../context.js";
import { requestAcceptedContext } from "./notify.js";

/** Re-poll search / transfers without blocking the worker lease. */
const ACQUIRE_POLL_MS = 2_000;

type DownloadPayload = {
  searchId?: string;
  /** Set after a usable search hit is selected. */
  selected?: SelectedSearchFile;
  /** Convenience mirrors used by older tests / re-entry. */
  user?: string;
  files?: Array<{ filename: string; size: number }>;
  enqueued?: boolean;
  /** Transfer id from the enqueue response, when that body included exactly one. */
  transferId?: string;
  /** Set once enqueue has succeeded. Retries must not extend it. */
  download_started_at?: number;
  selection_score?: { breakdown: Record<string, number>; total: number; signals: unknown };
};

function acquisitionUnavailable(provider: AcquisitionProvider): boolean {
  return provider.kind === "unverified" || provider.verifyStatus !== "verified";
}

function recordFailure(
  ctx: Parameters<JobHandler>[0],
  requestId: string,
  message: string,
  detail?: Record<string, unknown>,
): void {
  transitionRequest(ctx.db, {
    requestId,
    to: "FAILED",
    actor: ctx.workerId,
    payload: { error: message, reason: message, ...detail },
    patch: { error: message },
  });
}

function fail(
  ctx: Parameters<JobHandler>[0],
  requestId: string,
  message: string,
  detail?: Record<string, unknown>,
): never {
  recordFailure(ctx, requestId, message, detail);
  throw new Error(message);
}

function itemSaysEnqueued(items: AcquisitionItemRow[], selected: SelectedSearchFile): boolean {
  return items.some(
    (item) => item.status === "enqueued" && item.remote_user === selected.username && item.filename === selected.filename,
  );
}

/** A transfer `filename` that already lives under the configured container prefix. */
function containerReportedPath(filename: string, prefix: string): string | undefined {
  const trimmed = prefix.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return undefined;
  const norm = filename.replaceAll("\\", "/");
  const pref = trimmed.replaceAll("\\", "/");
  if (norm === pref || norm.startsWith(`${pref}/`)) return filename;
  return undefined;
}

function parsePayload(jobPayload: string | null): DownloadPayload {
  if (!jobPayload) return {};
  return JSON.parse(jobPayload) as DownloadPayload;
}

function selectedFromPayload(payload: DownloadPayload): SelectedSearchFile | null {
  if (payload.selected?.username && payload.selected.filename && payload.selected.size > 0) {
    return payload.selected;
  }
  if (payload.user && Array.isArray(payload.files) && payload.files[0]) {
    const file = payload.files[0];
    if (typeof file.filename === "string" && typeof file.size === "number" && file.size > 0) {
      return { username: payload.user, filename: file.filename, size: file.size };
    }
  }
  return null;
}

async function loadSearchResponses(
  provider: AcquisitionProvider,
  searchId: string,
): Promise<{ complete: boolean; payload: unknown }> {
  const search = await provider.getSearch(searchId, { includeResponses: true });
  const complete = isSearchComplete(search);
  const inline = (search as { responses?: unknown })?.responses;
  if (Array.isArray(inline) && inline.length > 0) {
    return { complete, payload: { responses: inline } };
  }
  if (complete) {
    const responses = await provider.getSearchResponses(searchId);
    if (Array.isArray(responses)) return { complete, payload: { responses } };
    return { complete, payload: responses };
  }
  return { complete, payload: search };
}

function scheduleDownload(
  ctx: Parameters<JobHandler>[0],
  requestId: string,
  payload: DownloadPayload,
): void {
  enqueueJob(ctx.db, {
    type: "download",
    requestId,
    payload,
    runAfter: Date.now() + ACQUIRE_POLL_MS,
  });
}

export const handleSearchAcquisition: JobHandler = async (ctx, job) => {
  if (!job.request_id) throw new Error("search_acquisition job missing request_id");
  const request = getRequest(ctx.db, job.request_id);
  if (!request) throw new Error("request not found");
  if (request.status !== "SEARCHING") return { skipped: true, status: request.status };

  if (acquisitionUnavailable(ctx.providers.acquisition)) {
    // Do not call the provider and do not announce REQUEST_ACCEPTED.
    throw new Error("acquire_unavailable");
  }

  const searchText = [request.artist, request.title].filter(Boolean).join(" ") || request.raw_query;
  const searchId = randomUUID();
  const result = await ctx.providers.acquisition.search(searchText, searchId);
  insertAcquisitionItem(ctx.db, {
    requestId: request.id,
    providerId: "acquisition-slskd",
    status: "searched",
    filename: searchText,
  });
  transitionRequest(ctx.db, {
    requestId: request.id,
    to: "QUEUED",
    actor: ctx.workerId,
    payload: { searchId, result },
  });
  // Download job polls search → selects → enqueues with real username/filename/size.
  enqueueJob(ctx.db, { type: "download", requestId: request.id, payload: { searchId } });
  return { searchId };
};

export const handleDownload: JobHandler = async (ctx, job) => {
  if (!job.request_id) throw new Error("download job missing request_id");
  const request = getRequest(ctx.db, job.request_id);
  if (!request) throw new Error("request not found");
  if (request.status !== "QUEUED" && request.status !== "DOWNLOADING") {
    return { skipped: true, status: request.status };
  }
  if (acquisitionUnavailable(ctx.providers.acquisition)) {
    throw new Error("acquire_unavailable");
  }

  let payload = parsePayload(job.payload_json);
  let selected = selectedFromPayload(payload);
  let selectionScore = payload.selection_score;

  // --- Phase 1: poll search + select + enqueue (QUEUED) ---
  if (request.status === "QUEUED") {
    if (!selected) {
      if (!payload.searchId) {
        fail(ctx, request.id, "download job missing searchId or selected file");
      }
      const { complete, payload: searchPayload } = await loadSearchResponses(
        ctx.providers.acquisition,
        payload.searchId,
      );
      if (!complete) {
        scheduleDownload(ctx, request.id, payload);
        return { waiting: true, reason: "search_incomplete", searchId: payload.searchId };
      }
      const selection = ctx.config.acquisition.selection;
      const decision = selectSearch(searchPayload, {
        allowedExtensions: ctx.config.files.allowed_extensions,
        minFileSizeMb: selection.min_file_size_mb,
        maxFileSizeMb: selection.max_file_size_mb,
        maxDurationSeconds: selection.max_duration_seconds,
        maxSampleRate: selection.max_sample_rate,
        maxBitDepth: selection.max_bit_depth,
        preferredMaxFileSizeMb: selection.preferred_max_file_size_mb,
        preferredMaxDurationSeconds: selection.preferred_max_duration_seconds,
        versionPreference: selection.version_preference,
        formatPreference: selection.format_preference,
        bitrateFloorKbps: selection.bitrate_floor_kbps,
        shortRecordingFraction: selection.short_recording_fraction,
        shortRecordingMinSamples: selection.short_recording_min_samples,
        shortRecordingFloorSeconds: selection.short_recording_floor_seconds,
        shortRecordingPenalty: selection.short_recording_penalty,
        versionPenaltyTerms: selection.version_penalty_terms,
        instrumentPartBasenames: selection.instrument_part_basenames,
        longRecordingPhrases: selection.long_recording_phrases,
        query: {
          artist: request.artist ?? undefined,
          title: request.title ?? undefined,
        },
      });
      if (decision.outcome === "selected") {
        selected = decision.file;
        selectionScore = {
          breakdown: decision.breakdown,
          total: decision.total,
          signals: decision.signals,
        };
      } else if (decision.outcome === "no_suitable_result") {
        // QUEUED → FAILED. Filters already removed every candidate; do not enqueue.
        fail(ctx, request.id, decision.reason, { outcome: "no_suitable_result", removed: decision.removed });
      } else {
        // No response rows, or rows with nothing the filters could consider.
        fail(ctx, request.id, "no usable search result");
      }
    }

    const files = [{ filename: selected.filename, size: selected.size }];
    const alreadyEnqueued = payload.enqueued === true || itemSaysEnqueued(listAcquisitionItems(ctx.db, request.id), selected);
    let transferId = payload.transferId;
    if (!alreadyEnqueued) {
      const snapshot = await ctx.providers.acquisition.listDownloads();
      const existingTransfer = findCorrelatedTransfer(snapshot, {
        username: selected.username,
        filename: selected.filename,
        size: selected.size,
      });
      if (existingTransfer) {
        transferId = existingTransfer.id ?? transferId;
      } else {
        const enqueuedBody = await ctx.providers.acquisition.enqueueDownload(selected.username, files);
        transferId =
          observedTransferId(enqueuedBody, { filename: selected.filename, size: selected.size }) ?? transferId;
      }
    }
    const started =
      typeof payload.download_started_at === "number" && Number.isFinite(payload.download_started_at)
        ? payload.download_started_at
        : Date.now();
    const nextPayload: DownloadPayload = {
      searchId: payload.searchId,
      selected,
      user: selected.username,
      files,
      enqueued: true,
      download_started_at: started,
      ...(transferId ? { transferId } : {}),
      ...(selectionScore ? { selection_score: selectionScore } : {}),
    };
    const existing = listAcquisitionItems(ctx.db, request.id);
    const itemId =
      existing[0]?.id ??
      insertAcquisitionItem(ctx.db, {
        requestId: request.id,
        providerId: "acquisition-slskd",
        status: "enqueued",
        remoteUser: selected.username,
        filename: selected.filename,
      });
    updateAcquisitionItem(ctx.db, itemId, {
      status: "enqueued",
      remote_user: selected.username,
      filename: selected.filename,
    });
    // Persist before say. A throw or a reclaimed lease must not POST again.
    updateJobPayload(ctx.db, job.id, nextPayload);
    // REQUEST_ACCEPTED only after enqueue succeeds (A4).
    await ctx.providers.radio.say({
      text: requestAcceptedContext(ctx.db, request),
      kind: "dj-speak",
    });
    transitionRequest(ctx.db, {
      requestId: request.id,
      to: "DOWNLOADING",
      actor: ctx.workerId,
      payload: {
        event: "REQUEST_ACCEPTED",
        selected,
        ...(selectionScore ? { selection_score: selectionScore } : {}),
      },
    });
    scheduleDownload(ctx, request.id, nextPayload);
    return { enqueued: true, selected, ...(selectionScore ? { selection_score: selectionScore } : {}) };
  }

  // --- Phase 2: poll transfers until correlated Completed+Succeeded + file exists ---
  selected = selectedFromPayload(payload);
  if (!selected) {
    fail(ctx, request.id, "download poll missing selected file correlation");
  }

  if (getRequest(ctx.db, request.id)?.status !== "DOWNLOADING") {
    return { skipped: true, status: getRequest(ctx.db, request.id)?.status };
  }

  const timeoutMs = ctx.config.acquisition.download_timeout_ms;
  const started = payload.download_started_at;
  if (typeof started !== "number" || !Number.isFinite(started)) {
    payload = { ...payload, selected, enqueued: true, download_started_at: Date.now() };
    updateJobPayload(ctx.db, job.id, payload);
  } else if (Date.now() - started >= timeoutMs) {
    recordFailure(ctx, request.id, "download_timeout");
    return { failed: true, reason: "download_timeout" };
  }

  const snapshot = await ctx.providers.acquisition.listDownloads();
  // Search hits have no id. Correlate on username + the original filename + size.
  // `transferId` is set only when the enqueue body included one real transfer id.
  const transfer = findCorrelatedTransfer(snapshot, {
    username: selected.username,
    filename: selected.filename,
    size: selected.size,
    ...(payload.transferId ? { id: payload.transferId } : {}),
  });

  const existing = listAcquisitionItems(ctx.db, request.id);
  const itemId =
    existing[0]?.id ??
    insertAcquisitionItem(ctx.db, {
      requestId: request.id,
      providerId: "acquisition-slskd",
      status: "downloading",
      remoteUser: selected.username,
      filename: selected.filename,
    });

  if (!transfer) {
    updateAcquisitionItem(ctx.db, itemId, {
      status: "waiting_transfer",
      remote_user: selected.username,
      filename: selected.filename,
    });
    // Do NOT false-complete on an empty / unrelated poll.
    scheduleDownload(ctx, request.id, { ...payload, selected, enqueued: true });
    return { waiting: true, reason: "transfer_not_found" };
  }

  updateAcquisitionItem(ctx.db, itemId, {
    status: transfer.state,
    progress: transfer.progress ?? null,
    remote_user: transfer.user ?? selected.username,
    filename: transfer.filename ?? selected.filename,
  });

  if (isTransferTerminalFailure(transfer.state)) {
    recordFailure(ctx, request.id, transfer.state);
    return { failed: true, reason: transfer.state };
  }

  if (!isTransferSucceeded(transfer.state)) {
    scheduleDownload(ctx, request.id, { ...payload, selected, enqueued: true });
    return { waiting: true, reason: "transfer_in_progress", state: transfer.state, progress: transfer.progress ?? null };
  }

  const remoteName = transfer.filename ?? selected.filename;
  const expectedSize = transfer.size ?? selected.size;
  const prefix = ctx.config.acquisition.downloads_path_prefix;
  const resolved = resolveDownloadedFile(ctx.config.paths.downloads, remoteName, expectedSize, {
    containerPrefix: prefix,
    reportedPath: containerReportedPath(remoteName, prefix),
  });
  if (!resolved) {
    recordFailure(ctx, request.id, "download_not_found");
    return { failed: true, reason: "download_not_found" };
  }
  const relative = path.relative(ctx.config.paths.downloads, resolved.absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    recordFailure(ctx, request.id, "download_not_found");
    return { failed: true, reason: "download_not_found" };
  }

  updateAcquisitionItem(ctx.db, itemId, {
    status: "completed",
    progress: 1,
    remote_user: selected.username,
    filename: resolved.basename,
    local_path: resolved.absolutePath,
  });

  transitionRequest(ctx.db, {
    requestId: request.id,
    to: "DOWNLOAD_COMPLETE",
    actor: ctx.workerId,
    payload: { selected, local_path: resolved.absolutePath, basename: resolved.basename },
  });
  enqueueJob(ctx.db, {
    type: "validate_file",
    requestId: request.id,
    payload: {
      filename: relative,
      path: resolved.absolutePath,
      size: resolved.size,
      ...(selected.durationSeconds !== undefined && selected.durationSeconds > 0
        ? { duration_seconds: selected.durationSeconds }
        : {}),
    },
  });
  return {
    completed: true,
    basename: resolved.basename,
    path: resolved.absolutePath,
    state: transfer.state,
  };
};
