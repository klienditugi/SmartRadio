import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  claimEnqueueAttempt,
  enqueueJob,
  getRequest,
  insertAcquisitionItem,
  listAcquisitionItems,
  transitionRequest,
  updateAcquisitionItem,
  updateJobPayload,
  type AcquisitionItemRow,
  type EnqueueAttemptMarker,
} from "@subwave-ai/db";
import {
  findCorrelatedTransfer,
  isSearchComplete,
  isTransferSucceeded,
  isTransferTerminalFailure,
  observedTransferId,
  resolveDownloadedFile,
  type CorrelatedTransfer,
  type ResolveDownloadResult,
  ProviderHttpError,
  selectSearch,
  type AcquisitionProvider,
  type SelectedSearchFile,
} from "@subwave-ai/providers";
import type { JobHandler } from "../context.js";
import { failRequest, failureReasonCategory } from "./fail-request.js";
import { sayListenerFacts } from "./say-listener.js";

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
  /** Selector version class of `selected`. Copied through to the radio handoff. */
  version_class?: string;
  /**
   * Written before POST /transfers/downloads. A later worker must not POST
   * again for this username, filename, and size.
   */
  enqueue_attempted?: EnqueueAttemptMarker;
};

function acquisitionUnavailable(provider: AcquisitionProvider): boolean {
  return provider.kind === "unverified" || provider.verifyStatus !== "verified";
}

async function recordFailure(
  ctx: Parameters<JobHandler>[0],
  requestId: string,
  message: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await failRequest(ctx, {
    requestId,
    reason: failureReasonCategory(message),
    payload: { error: message, reason: message, ...detail },
    patch: { error: message },
  });
}

async function fail(
  ctx: Parameters<JobHandler>[0],
  requestId: string,
  message: string,
  detail?: Record<string, unknown>,
): Promise<never> {
  await recordFailure(ctx, requestId, message, detail);
  throw new Error(message);
}

/** A definite slskd HTTP error. Timeouts and network failures have no status. */
function httpFailureStatus(err: unknown): number | undefined {
  if (!(err instanceof ProviderHttpError)) return undefined;
  if (err.status >= 400 && err.status <= 599) return err.status;
  return undefined;
}

async function failEnqueue(ctx: Parameters<JobHandler>[0], requestId: string, status: number) {
  await recordFailure(ctx, requestId, "enqueue_failed", { status });
  return { failed: true as const, reason: "enqueue_failed" as const, status };
}

/** Search `length` in seconds. Missing, null, and non-positive values are not a length. */
function hasPositiveLength(selected: SelectedSearchFile): boolean {
  const length = (selected as { durationSeconds?: unknown }).durationSeconds;
  return typeof length === "number" && Number.isFinite(length) && length > 0;
}

function itemSaysEnqueued(items: AcquisitionItemRow[], selected: SelectedSearchFile): boolean {
  return items.some(
    (item) => item.status === "enqueued" && item.remote_user === selected.username && item.filename === selected.filename,
  );
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

/** Poll payload for a marker that is set and whose transfer row is not visible yet. */
function markedPollPayload(
  payload: DownloadPayload,
  selected: SelectedSearchFile,
  files: Array<{ filename: string; size: number }>,
  attempt: EnqueueAttemptMarker,
  selectionScore: DownloadPayload["selection_score"],
  versionClass: string | undefined,
): DownloadPayload {
  return {
    searchId: payload.searchId,
    selected,
    user: selected.username,
    files,
    enqueue_attempted: attempt,
    download_started_at: attempt.at,
    ...(selectionScore ? { selection_score: selectionScore } : {}),
    ...(versionClass ? { version_class: versionClass } : {}),
  };
}

export const handleSearchAcquisition: JobHandler = async (ctx, job) => {
  if (!job.request_id) throw new Error("search_acquisition job missing request_id");
  const request = getRequest(ctx.db, job.request_id);
  if (!request) throw new Error("request not found");
  if (request.status !== "SEARCHING") return { skipped: true, status: request.status };

  if (acquisitionUnavailable(ctx.providers.acquisition)) {
    // Retryable job error. The request stays SEARCHING and is not FAILED,
    // so there is no listener say until a later path actually fails it.
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
    // Same retry as search: do not move the request to FAILED and do not say.
    throw new Error("acquire_unavailable");
  }

  let payload = parsePayload(job.payload_json);
  let selected = selectedFromPayload(payload);
  let selectionScore = payload.selection_score;
  let versionClass = payload.version_class;

  // --- Phase 1: poll search + select + enqueue (QUEUED) ---
  if (request.status === "QUEUED") {
    if (!selected) {
      if (!payload.searchId) {
        return await fail(ctx, request.id, "download job missing searchId or selected file");
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
        versionClass = decision.versionClass;
        selectionScore = {
          breakdown: decision.breakdown,
          total: decision.total,
          signals: decision.signals,
        };
      } else if (decision.outcome === "no_suitable_result") {
        // QUEUED → FAILED. Filters already removed every candidate; do not enqueue.
        return await fail(ctx, request.id, decision.reason, { outcome: "no_suitable_result", removed: decision.removed });
      } else {
        // No response rows, or rows with nothing the filters could consider.
        return await fail(ctx, request.id, "no usable search result");
      }
    }

    const chosen = selected;
    const files = [{ filename: chosen.filename, size: chosen.size }];
    const alreadyEnqueued = payload.enqueued === true || itemSaysEnqueued(listAcquisitionItems(ctx.db, request.id), chosen);
    let transferId = payload.transferId;
    let attempt = payload.enqueue_attempted;
    if (!alreadyEnqueued) {
      const target = {
        username: chosen.username,
        filename: chosen.filename,
        size: chosen.size,
      };
      const snapshot = await ctx.providers.acquisition.listDownloads();
      const existingTransfer = findCorrelatedTransfer(snapshot, target);
      // Marker already saved: never POST. Adopt the row, or fail at the deadline.
      const settleMarked = async (
        found: CorrelatedTransfer | null,
        marked: EnqueueAttemptMarker,
      ): Promise<{ waiting: true; reason: "enqueue_attempted" } | { failed: true; reason: "transfer_not_found" } | null> => {
        if (found) {
          transferId = found.id ?? transferId;
          return null;
        }
        if (Date.now() - marked.at >= ctx.config.acquisition.download_timeout_ms) {
          await recordFailure(ctx, request.id, "transfer_not_found");
          return { failed: true, reason: "transfer_not_found" };
        }
        scheduleDownload(
          ctx,
          request.id,
          markedPollPayload(payload, chosen, files, marked, selectionScore, versionClass),
        );
        return { waiting: true, reason: "enqueue_attempted" };
      };
      if (attempt) {
        const settled = await settleMarked(existingTransfer, attempt);
        if (settled) return settled;
      } else if (existingTransfer) {
        transferId = existingTransfer.id ?? transferId;
      } else if (!hasPositiveLength(chosen)) {
        // The selector is frozen and is not asked for another file.
        await recordFailure(ctx, request.id, "selected_missing_length");
        return { failed: true, reason: "selected_missing_length" };
      } else {
        const claim = claimEnqueueAttempt(ctx.db, {
          jobId: job.id,
          requestId: request.id,
          username: chosen.username,
          filename: chosen.filename,
          size: chosen.size,
        });
        attempt = claim.marker;
        payload = { ...payload, enqueue_attempted: attempt };
        if (!claim.claimed) {
          const again = await ctx.providers.acquisition.listDownloads();
          const settled = await settleMarked(findCorrelatedTransfer(again, target), attempt);
          if (settled) return settled;
        } else {
          try {
            const enqueuedBody = await ctx.providers.acquisition.enqueueDownload(chosen.username, files);
            transferId =
              observedTransferId(enqueuedBody, { filename: chosen.filename, size: chosen.size }) ?? transferId;
          } catch (err) {
            const status = httpFailureStatus(err);
            if (status !== undefined && status < 500) {
              // 4xx: slskd refused the enqueue. Marker stays. No poll and no second POST.
              return failEnqueue(ctx, request.id, status);
            }
            if (status !== undefined) {
              // 5xx does not prove the transfer is absent. Look once, then stop.
              try {
                const again = await ctx.providers.acquisition.listDownloads();
                const found = findCorrelatedTransfer(again, target);
                if (!found) return failEnqueue(ctx, request.id, status);
                transferId = found.id ?? transferId;
              } catch {
                return failEnqueue(ctx, request.id, status);
              }
            } else {
              // No HTTP response: timeout, network error, or a lost reply. Poll only.
              const again = await ctx.providers.acquisition.listDownloads();
              const settled = await settleMarked(findCorrelatedTransfer(again, target), attempt);
              if (settled) return settled;
            }
          }
        }
      }
    }
    const started =
      typeof payload.download_started_at === "number" && Number.isFinite(payload.download_started_at)
        ? payload.download_started_at
        : (attempt?.at ?? Date.now());
    const nextPayload: DownloadPayload = {
      searchId: payload.searchId,
      selected: chosen,
      user: chosen.username,
      files,
      enqueued: true,
      download_started_at: started,
      ...(transferId ? { transferId } : {}),
      ...(attempt ? { enqueue_attempted: attempt } : {}),
      ...(selectionScore ? { selection_score: selectionScore } : {}),
      ...(versionClass ? { version_class: versionClass } : {}),
    };
    const existing = listAcquisitionItems(ctx.db, request.id);
    const itemId =
      existing[0]?.id ??
      insertAcquisitionItem(ctx.db, {
        requestId: request.id,
        providerId: "acquisition-slskd",
        status: "enqueued",
        remoteUser: chosen.username,
        filename: chosen.filename,
      });
    updateAcquisitionItem(ctx.db, itemId, {
      status: "enqueued",
      remote_user: chosen.username,
      filename: chosen.filename,
    });
    // Persist before the status move. A reclaimed lease must not POST again.
    updateJobPayload(ctx.db, job.id, nextPayload);
    // REQUEST_ACCEPTED is the status move. The listener say must not block it.
    transitionRequest(ctx.db, {
      requestId: request.id,
      to: "DOWNLOADING",
      actor: ctx.workerId,
      payload: {
        event: "REQUEST_ACCEPTED",
        selected: chosen,
        ...(selectionScore ? { selection_score: selectionScore } : {}),
      },
    });
    scheduleDownload(ctx, request.id, nextPayload);
    const accepted = getRequest(ctx.db, request.id) ?? request;
    await sayListenerFacts(ctx, accepted, { event: "copy_found_retrieval_started" });
    return { enqueued: true, selected: chosen, ...(selectionScore ? { selection_score: selectionScore } : {}) };
  }

  // --- Phase 2: poll transfers until correlated Completed+Succeeded + file exists ---
  selected = selectedFromPayload(payload);
  if (!selected) {
    return await fail(ctx, request.id, "download poll missing selected file correlation");
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
    await recordFailure(ctx, request.id, "download_timeout");
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
    await recordFailure(ctx, request.id, transfer.state);
    return { failed: true, reason: transfer.state };
  }

  if (!isTransferSucceeded(transfer.state)) {
    scheduleDownload(ctx, request.id, { ...payload, selected, enqueued: true });
    return { waiting: true, reason: "transfer_in_progress", state: transfer.state, progress: transfer.progress ?? null };
  }

  const remoteName = transfer.filename ?? selected.filename;
  const expectedSize = transfer.size ?? selected.size;
  // slskd 0.26 Transfer has no local path. `filename` is the remote path, so
  // resolution is paths.downloads/<last remote folder>/<basename>.
  const located: ResolveDownloadResult = resolveDownloadedFile(
    ctx.config.paths.downloads,
    remoteName,
    expectedSize,
    { containerDownloadsDir: ctx.config.acquisition.downloads_path_prefix },
  );
  if (!located.ok) {
    const listed = located.tried.length > 0 ? located.tried.join(", ") : "(none)";
    await recordFailure(ctx, request.id, `download_not_found: tried ${listed}`);
    return { failed: true, reason: "download_not_found", tried: located.tried };
  }
  const resolved = located.file;
  const relative = path.relative(ctx.config.paths.downloads, resolved.absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    await recordFailure(ctx, request.id, `download_not_found: tried ${resolved.absolutePath}`);
    return { failed: true, reason: "download_not_found", tried: [resolved.absolutePath] };
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
      ...(payload.version_class ? { version_class: payload.version_class } : {}),
    },
  });
  return {
    completed: true,
    basename: resolved.basename,
    path: resolved.absolutePath,
    state: transfer.state,
  };
};
