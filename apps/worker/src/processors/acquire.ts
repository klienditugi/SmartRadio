import { randomUUID } from "node:crypto";
import {
  enqueueJob,
  getRequest,
  insertAcquisitionItem,
  listAcquisitionItems,
  transitionRequest,
  updateAcquisitionItem,
} from "@subwave-ai/db";
import { extractTransferProgress } from "@subwave-ai/providers";
import type { JobHandler } from "../context.js";

export const handleSearchAcquisition: JobHandler = async (ctx, job) => {
  if (!job.request_id) throw new Error("search_acquisition job missing request_id");
  const request = getRequest(ctx.db, job.request_id);
  if (!request) throw new Error("request not found");
  if (request.status !== "SEARCHING") return { skipped: true, status: request.status };

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
  if (request.status === "QUEUED") {
    transitionRequest(ctx.db, { requestId: request.id, to: "DOWNLOADING", actor: ctx.workerId });
  }
  const current = getRequest(ctx.db, request.id)!;
  if (current.status !== "DOWNLOADING") return { skipped: true, status: current.status };

  const payload = job.payload_json ? (JSON.parse(job.payload_json) as { user?: string; files?: unknown }) : {};
  if (payload.user && payload.files) {
    await ctx.providers.acquisition.enqueueDownload(payload.user, payload.files);
  }
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
