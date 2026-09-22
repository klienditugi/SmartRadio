import { randomUUID } from "node:crypto";
import {
  enqueueJob,
  getRequest,
  insertAcquisitionItem,
  listAcquisitionItems,
  transitionRequest,
  updateAcquisitionItem,
} from "@subwave-ai/db";
import {
  findCorrelatedTransfer,
  isSearchComplete,
  isTransferErrored,
  isTransferSucceeded,
  resolveDownloadedFile,
  selectSearchResult,
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
};

function acquisitionUnavailable(provider: AcquisitionProvider): boolean {
  return provider.kind === "unverified" || provider.verifyStatus !== "verified";
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

  const payload = parsePayload(job.payload_json);
  let selected = selectedFromPayload(payload);

  // --- Phase 1: poll search + select + enqueue (QUEUED) ---
  if (request.status === "QUEUED" && !payload.enqueued) {
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
      selected = selectSearchResult(searchPayload, {
        allowedExtensions: ctx.config.files.allowed_extensions,
      });
      if (!selected) {
        fail(ctx, request.id, "no usable search result");
      }
    }

    const files = [{ filename: selected.filename, size: selected.size }];
    await ctx.providers.acquisition.enqueueDownload(selected.username, files);
    // REQUEST_ACCEPTED only after enqueue succeeds (A4).
    await ctx.providers.radio.say({
      text: requestAcceptedContext(ctx.db, request),
      kind: "dj-speak",
    });
    transitionRequest(ctx.db, {
      requestId: request.id,
      to: "DOWNLOADING",
      actor: ctx.workerId,
      payload: { event: "REQUEST_ACCEPTED", selected },
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
    updateAcquisitionItem(ctx.db, itemId, {
      status: "enqueued",
      remote_user: selected.username,
      filename: selected.filename,
    });
    scheduleDownload(ctx, request.id, {
      searchId: payload.searchId,
      selected,
      user: selected.username,
      files,
      enqueued: true,
    });
    return { enqueued: true, selected };
  }

  // --- Phase 2: poll transfers until correlated Completed+Succeeded + file exists ---
  selected = selectedFromPayload(payload);
  if (!selected) {
    fail(ctx, request.id, "download poll missing selected file correlation");
  }

  const current = getRequest(ctx.db, request.id)!;
  if (current.status === "QUEUED" && payload.enqueued) {
    // Should already be DOWNLOADING; recover if needed.
    transitionRequest(ctx.db, {
      requestId: request.id,
      to: "DOWNLOADING",
      actor: ctx.workerId,
      payload: { selected },
    });
  }
  if (getRequest(ctx.db, request.id)?.status !== "DOWNLOADING") {
    return { skipped: true, status: getRequest(ctx.db, request.id)?.status };
  }

  const snapshot = await ctx.providers.acquisition.listDownloads();
  const transfer = findCorrelatedTransfer(snapshot, {
    username: selected.username,
    filename: selected.filename,
    size: selected.size,
    id: selected.fileId,
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

  if (isTransferErrored(transfer.state)) {
    fail(ctx, request.id, `transfer errored: ${transfer.state}`);
  }

  if (!isTransferSucceeded(transfer.state)) {
    scheduleDownload(ctx, request.id, { ...payload, selected, enqueued: true });
    return { waiting: true, reason: "transfer_in_progress", state: transfer.state, progress: transfer.progress ?? null };
  }

  const resolved = resolveDownloadedFile(ctx.config.paths.downloads, selected.filename, selected.size);
  if (!resolved) {
    fail(ctx, request.id, `download missing under paths.downloads: ${selected.filename}`);
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
    payload: { filename: resolved.basename, path: resolved.absolutePath },
  });
  return {
    completed: true,
    basename: resolved.basename,
    path: resolved.absolutePath,
    state: transfer.state,
  };
};
