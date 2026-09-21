import { applyStationPolicy } from "@subwave-ai/core";
import {
  enqueueJob,
  getRequest,
  recordLlmCall,
  transitionRequest,
} from "@subwave-ai/db";
import type { JobHandler } from "../context.js";

export const handleClassify: JobHandler = async (ctx, job) => {
  if (!job.request_id) throw new Error("classify job missing request_id");
  const request = getRequest(ctx.db, job.request_id);
  if (!request) throw new Error("request not found");
  if (request.status === "RECEIVED") {
    transitionRequest(ctx.db, { requestId: request.id, to: "CLASSIFYING", actor: ctx.workerId });
  } else if (request.status !== "CLASSIFYING") {
    return { skipped: true, status: request.status };
  }

  const prompt = request.raw_query;
  const started = Date.now();
  try {
    const classification = await ctx.providers.llm.classify({
      text: prompt,
      model: ctx.config.llm.model,
    });
    recordLlmCall(ctx.db, {
      requestId: request.id,
      providerId: "llm-ollama",
      model: ctx.config.llm.model,
      prompt,
      response: classification,
      parsedOk: true,
      latencyMs: Date.now() - started,
    });
    const policy = applyStationPolicy(classification, ctx.config.policy);
    if (policy.decision === "REJECTED") {
      transitionRequest(ctx.db, {
        requestId: request.id,
        to: "REJECTED",
        actor: ctx.workerId,
        payload: { policy },
        patch: {
          artist: classification.artist,
          title: classification.title,
          genre: classification.genre,
          classification_json: JSON.stringify(classification),
          policy_json: JSON.stringify(policy),
        },
      });
      return { decision: "REJECTED", policy };
    }
    transitionRequest(ctx.db, {
      requestId: request.id,
      to: "APPROVED",
      actor: ctx.workerId,
      payload: { policy },
      patch: {
        artist: classification.artist,
        title: classification.title,
        genre: classification.genre,
        classification_json: JSON.stringify(classification),
        policy_json: JSON.stringify(policy),
        error: null,
      },
    });
    enqueueJob(ctx.db, { type: "check_library", requestId: request.id });
    return { decision: "APPROVED", policy, classification };
  } catch (err) {
    recordLlmCall(ctx.db, {
      requestId: request.id,
      providerId: "llm-ollama",
      model: ctx.config.llm.model,
      prompt,
      parsedOk: false,
      latencyMs: Date.now() - started,
      error: (err as Error).message,
    });
    const current = getRequest(ctx.db, request.id);
    if (current && current.status !== "FAILED" && current.status !== "CANCELLED") {
      transitionRequest(ctx.db, {
        requestId: request.id,
        to: "FAILED",
        actor: ctx.workerId,
        payload: { error: (err as Error).message },
        patch: { error: (err as Error).message },
      });
    }
    throw err;
  }
};
