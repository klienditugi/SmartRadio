import type { FastifyInstance } from "fastify";
import {
  cancelJob,
  enqueueJob,
  getJob,
  listAcquisitionItems,
  listJobAttempts,
  listJobs,
  listProviders,
  listSettings,
  putSetting,
} from "@subwave-ai/db";
import { JOB_TYPES, publicSettings, type JobType } from "@subwave-ai/shared";
import { requireAdmin, requireUser } from "./auth.js";

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/providers", { schema: { tags: ["providers"] }, preHandler: requireUser }, async () => {
    return { providers: listProviders(app.db) };
  });

  app.get("/settings", { schema: { tags: ["settings"] }, preHandler: requireUser }, async () => {
    return {
      config: publicSettings(app.config),
      settings: listSettings(app.db),
    };
  });

  app.put(
    "/settings",
    {
      schema: {
        tags: ["settings"],
        body: {
          type: "object",
          additionalProperties: true,
        },
      },
      preHandler: requireAdmin,
    },
    async (request) => {
      const body = request.body as Record<string, unknown>;
      for (const [key, value] of Object.entries(body)) {
        putSetting(app.db, key, value, request.user?.id);
      }
      return { ok: true, settings: listSettings(app.db) };
    },
  );

  app.get("/admin/jobs", { schema: { tags: ["admin"] }, preHandler: requireAdmin }, async () => {
    return { jobs: listJobs(app.db) };
  });

  app.get("/admin/jobs/:id", { schema: { tags: ["admin"] }, preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = getJob(app.db, id);
    if (!job) return reply.code(404).send({ error: "not found" });
    return { job, attempts: listJobAttempts(app.db, id) };
  });

  app.post("/admin/jobs/:id/cancel", { schema: { tags: ["admin"] }, preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = cancelJob(app.db, id);
    if (!job) return reply.code(404).send({ error: "not found" });
    return { job };
  });

  app.post(
    "/admin/jobs",
    {
      schema: {
        tags: ["admin"],
        body: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string" },
            request_id: { type: "string" },
            payload: { type: "object" },
          },
        },
      },
      preHandler: requireAdmin,
    },
    async (request, reply) => {
      const body = request.body as { type: string; request_id?: string; payload?: unknown };
      if (!JOB_TYPES.includes(body.type as JobType)) {
        return reply.code(400).send({ error: "unknown job type" });
      }
      const job = enqueueJob(app.db, {
        type: body.type as JobType,
        requestId: body.request_id,
        payload: body.payload,
      });
      return reply.code(201).send({ job });
    },
  );

  app.post("/admin/library/scan", { schema: { tags: ["admin"] }, preHandler: requireAdmin }, async (_request, reply) => {
    const job = enqueueJob(app.db, { type: "index_library", payload: { standalone: true } });
    return reply.code(201).send({ job, note: "Worker will call Navidrome startScan/getScanStatus." });
  });

  app.post("/admin/health-probe", { schema: { tags: ["admin"] }, preHandler: requireAdmin }, async (_request, reply) => {
    const job = enqueueJob(app.db, { type: "health_probe" });
    return reply.code(201).send({ job });
  });

  app.post("/admin/radio/refresh-playlist", { schema: { tags: ["admin"] }, preHandler: requireAdmin }, async (_request, reply) => {
    const job = enqueueJob(app.db, { type: "refresh_playlist" });
    return reply.code(201).send({
      job,
      note: "Worker will POST SUB/WAVE /dj/refresh-playlist (verified admin Basic). Payload schema of the radio response is opaque.",
    });
  });

  app.get("/admin/acquisitions", { schema: { tags: ["admin"] }, preHandler: requireAdmin }, async () => {
    return { acquisitions: listAcquisitionItems(app.db) };
  });
}
