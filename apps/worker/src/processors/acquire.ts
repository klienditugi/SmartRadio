import { randomUUID } from "node:crypto";
import {
  enqueueJob,
  getRequest,
  insertAcquisitionItem,
  listAcquisitionItems,
  transitionRequest,
  updateAcquisitionItem,
} from "@subwave-ai/db";
import { extractTransferProgress, type AcquisitionProvider } from "@subwave-ai/providers";
import type { JobHandler } from "../context.js";
import { requestAcceptedContext } from "./notify.js";

function acquisitionUnavailable(provider: AcquisitionProvider): boolean {
  return provider.kind === "unverified" || provider.verifyStatus !== "verified";
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

  const payload = job.payload_json ? (JSON.parse(job.payload_json) as { user?: string; files?: unknown }) : {};
  const hasTransfer = Boolean(payload.user) && payload.files !== undefined;
  // REQUEST_ACCEPTED only after a transfer is actually accepted. Search alone is earlier,
  // and a poll with no enqueue is not a start.
  if (request.status === "QUEUED" && hasTransfer) {
    await ctx.providers.acquisition.enqueueDownload(payload.user as string, payload.files);
    await ctx.providers.radio.say({
      text: requestAcceptedContext(ctx.db, request),
      kind: "dj-speak",
    });
    transitionRequest(ctx.db, {
      requestId: request.id,
      to: "DOWNLOADING",
      actor: ctx.workerId,
      payload: { event: "REQUEST_ACCEPTED" },
    });
  } else if (request.status === "QUEUED") {
    transitionRequest(ctx.db, { requestId: request.id, to: "DOWNLOADING", actor: ctx.workerId });
  } else if (hasTransfer) {
    await ctx.providers.acquisition.enqueueDownload(payload.user as string, payload.files);
  }

  const current = getRequest(ctx.db, request.id)!;
  if (current.status !== "DOWNLOADING") return { skipped: true, status: current.status };

  const snapshot = await ctx.providers.acquisition.listDownloads();
  // Transfer JSON field names are NEEDS_SERVER_INSPECTION. Persist a snapshot
  // and any numeric progress we can read without inventing slskd schema.
  const extracted = extractTransferProgress(snapshot);
  const existing = listAcquisitionItems(ctx.db, request.id);
  const itemId =
    existing[0]?.id ??
    insertAcquisitionItem(ctx.db, {
      requestId: request.id,
      providerId: "acquisition-slskd",
      status: "downloading",
      remoteUser: payload.user,
    });
  const first = extracted[0];
  updateAcquisitionItem(ctx.db, itemId, {
    status: first?.status ?? "polled",
    progress: first?.progress ?? null,
    remote_user: first?.user ?? payload.user ?? null,
    filename: first?.filename ?? null,
  });
  transitionRequest(ctx.db, { requestId: request.id, to: "DOWNLOAD_COMPLETE", actor: ctx.workerId });
  enqueueJob(ctx.db, { type: "validate_file", requestId: request.id });
  return { polled: true, snapshot_keys: extracted.flatMap((row) => row.raw_keys).slice(0, 32), progress: first?.progress ?? null };
};
