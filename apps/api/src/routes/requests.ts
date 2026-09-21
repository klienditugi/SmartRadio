import type { FastifyInstance } from "fastify";
import { restartStatusForJob } from "@subwave-ai/core";
import { isRequestStatus } from "@subwave-ai/shared";
import {
  cancelJobsForRequest,
  createRequest,
  enqueueJob,
  getRequest,
  listAcquisitionItems,
  listJobsForRequest,
  listLibraryMatches,
  listLlmCalls,
  listRequestEvents,
  listRequests,
  transitionRequest,
} from "@subwave-ai/db";
import { requireAdmin, requireUser } from "./auth.js";

export async function registerRequestRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/requests",
    {
      schema: {
        tags: ["requests"],
        body: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
      },
      preHandler: requireUser,
    },
    async (request, reply) => {
      const body = request.body as { text: string };
      const created = createRequest(app.db, { userId: request.user?.id, rawQuery: body.text.trim() });
      const job = enqueueJob(app.db, { type: "classify", requestId: created.id, payload: { requestId: created.id } });
      return reply.code(201).send({ request: created, job_id: job.id });
    },
  );

  app.get("/requests", { schema: { tags: ["requests"] }, preHandler: requireUser }, async (request) => {
    const query = request.query as { limit?: string; status?: string };
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const status = query.status && isRequestStatus(query.status) ? query.status : undefined;
    return { requests: listRequests(app.db, limit, status) };
  });

  app.get("/requests/:id", { schema: { tags: ["requests"] }, preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getRequest(app.db, id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return {
      request: row,
      events: listRequestEvents(app.db, id),
      jobs: listJobsForRequest(app.db, id),
      acquisitions: listAcquisitionItems(app.db, id),
      matches: listLibraryMatches(app.db, id),
      llm_calls: listLlmCalls(app.db, { requestId: id, limit: 20 }).map((call) => ({
        ...call,
        prompt: call.prompt.length > 280 ? `${call.prompt.slice(0, 280)}…` : call.prompt,
      })),
    };
  });

  app.get("/requests/:id/jobs", { schema: { tags: ["requests"] }, preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getRequest(app.db, id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return { jobs: listJobsForRequest(app.db, id) };
  });

  app.get("/requests/:id/acquisitions", { schema: { tags: ["requests"] }, preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getRequest(app.db, id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return { acquisitions: listAcquisitionItems(app.db, id) };
  });

  app.get("/requests/:id/events", { schema: { tags: ["requests"] }, preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getRequest(app.db, id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return { events: listRequestEvents(app.db, id) };
  });

  app.post("/requests/:id/cancel", { schema: { tags: ["requests"] }, preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getRequest(app.db, id);
    if (!row) return reply.code(404).send({ error: "not found" });
    try {
      const updated = transitionRequest(app.db, {
        requestId: id,
        to: "CANCELLED",
        actor: request.user?.username ?? "api",
      });
      cancelJobsForRequest(app.db, id);
      return { request: updated };
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.post("/requests/:id/retry", { schema: { tags: ["requests"] }, preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getRequest(app.db, id);
    if (!row) return reply.code(404).send({ error: "not found" });
    if (row.status !== "FAILED") {
      return reply.code(409).send({ error: "retry is only valid from FAILED" });
    }
    const jobs = listJobsForRequest(app.db, id);
    const last = [...jobs].reverse().find((job) => job.status === "failed") ?? jobs.at(-1);
    const restart = last ? restartStatusForJob(last.type) : "RECEIVED";
    const to = restart ?? "RECEIVED";
    const updated = transitionRequest(app.db, {
      requestId: id,
      to,
      actor: request.user?.username ?? "api",
      payload: { retry: true, from_job: last?.type ?? null },
      patch: { error: null },
    });
    const jobType = last?.type ?? "classify";
    const job = enqueueJob(app.db, { type: jobType === "health_probe" ? "classify" : jobType, requestId: id });
    return { request: updated, job_id: job.id };
  });

  app.post("/requests/:id/approve", { schema: { tags: ["requests"] }, preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getRequest(app.db, id);
    if (!row) return reply.code(404).send({ error: "not found" });
    try {
      const updated = transitionRequest(app.db, {
        requestId: id,
        to: "APPROVED",
        actor: request.user?.username ?? "admin",
        payload: { admin: "approve" },
        patch: { error: null },
      });
      const job = enqueueJob(app.db, { type: "check_library", requestId: id });
      return { request: updated, job_id: job.id };
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.post("/requests/:id/reject", { schema: { tags: ["requests"] }, preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getRequest(app.db, id);
    if (!row) return reply.code(404).send({ error: "not found" });
    try {
      const updated = transitionRequest(app.db, {
        requestId: id,
        to: "REJECTED",
        actor: request.user?.username ?? "admin",
        payload: { admin: "reject" },
      });
      cancelJobsForRequest(app.db, id);
      return { request: updated };
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.post("/requests/:id/reclassify", { schema: { tags: ["requests"] }, preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getRequest(app.db, id);
    if (!row) return reply.code(404).send({ error: "not found" });
    try {
      const updated = transitionRequest(app.db, {
        requestId: id,
        to: "RECEIVED",
        actor: request.user?.username ?? "admin",
        payload: { admin: "reclassify" },
        patch: { error: null },
      });
      cancelJobsForRequest(app.db, id);
      const job = enqueueJob(app.db, { type: "classify", requestId: id });
      return { request: updated, job_id: job.id };
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.post("/requests/:id/retry-acquisition", { schema: { tags: ["requests"] }, preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getRequest(app.db, id);
    if (!row) return reply.code(404).send({ error: "not found" });
    if (row.status !== "FAILED") {
      return reply.code(409).send({ error: "retry acquisition is only valid from FAILED" });
    }
    try {
      const updated = transitionRequest(app.db, {
        requestId: id,
        to: "SEARCHING",
        actor: request.user?.username ?? "admin",
        payload: { admin: "retry-acquisition" },
        patch: { error: null },
      });
      cancelJobsForRequest(app.db, id);
      const job = enqueueJob(app.db, { type: "search_acquisition", requestId: id });
      return { request: updated, job_id: job.id };
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });
}
