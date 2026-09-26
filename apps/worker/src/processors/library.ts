import { enqueueJob, getRequest, insertLibraryMatch, transitionRequest } from "@subwave-ai/db";
import { NotConfiguredError } from "@subwave-ai/providers";
import type { JobHandler } from "../context.js";
import { runIntegration } from "./guard.js";

export const handleCheckLibrary: JobHandler = async (ctx, job) => {
  if (!job.request_id) throw new Error("check_library job missing request_id");
  const request = getRequest(ctx.db, job.request_id);
  if (!request) throw new Error("request not found");
  if (request.status === "APPROVED") {
    transitionRequest(ctx.db, { requestId: request.id, to: "CHECKING_LIBRARY", actor: ctx.workerId });
  }
  const current = getRequest(ctx.db, request.id)!;
  if (current.status !== "CHECKING_LIBRARY") return { skipped: true, status: current.status };

  const query = [current.artist, current.title].filter(Boolean).join(" ") || current.raw_query;
  let songs;
  try {
    songs = await runIntegration(ctx, request.id, () => ctx.providers.library.search3(query, { songCount: 10 }));
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      const row = getRequest(ctx.db, request.id);
      if (row && row.status !== "FAILED" && row.status !== "CANCELLED" && row.status !== "REJECTED" && row.status !== "READY") {
        transitionRequest(ctx.db, {
          requestId: request.id,
          to: "FAILED",
          actor: ctx.workerId,
          payload: { error: err.message, outcome: "not_configured" },
          patch: { error: err.message },
        });
      }
    }
    throw err;
  }
  const match = songs[0];
  if (match) {
    insertLibraryMatch(ctx.db, {
      requestId: request.id,
      providerId: "library-navidrome",
      songId: match.id,
      artist: match.artist,
      title: match.title,
      path: match.path,
      score: 1,
    });
    transitionRequest(ctx.db, {
      requestId: request.id,
      to: "ALREADY_AVAILABLE",
      actor: ctx.workerId,
      payload: { song_id: match.id },
    });
    enqueueJob(ctx.db, { type: "queue_radio", requestId: request.id, payload: { song_id: match.id } });
    return { match };
  }
  transitionRequest(ctx.db, { requestId: request.id, to: "SEARCHING", actor: ctx.workerId });
  enqueueJob(ctx.db, { type: "search_acquisition", requestId: request.id });
  return { match: null };
};
