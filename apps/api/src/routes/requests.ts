import type { FastifyInstance } from "fastify";
import { restartStatusForJob } from "@subwave-ai/core";
import {
  cancelJobsForRequest,
  createRequest,
  enqueueJob,
  getRequest,
  listJobsForRequest,
  listRequestEvents,
  listRequests,
  transitionRequest,
} from "@subwave-ai/db";
import { requireUser } from "./auth.js";

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

  app.get("/requests", { schema: { tags: ["requests"] }, preHandler: requireUser }, async () => {
    return { requests: listRequests(app.db) };
  });

  app.get("/requests/:id", { schema: { tags: ["requests"] }, preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getRequest(app.db, id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return { request: row };
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
}
