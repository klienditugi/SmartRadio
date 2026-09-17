import type { FastifyInstance } from "fastify";
import { enqueueJob, listJobs, listProviders } from "@subwave-ai/db";
import { listSettings, putSetting } from "@subwave-ai/db";
import { publicSettings } from "@subwave-ai/shared";
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
      const allowed = [
        "classify",
        "check_library",
        "search_acquisition",
        "download",
        "validate_file",
        "import_library",
        "index_library",
        "queue_radio",
        "health_probe",
      ] as const;
      if (!allowed.includes(body.type as (typeof allowed)[number])) {
        return reply.code(400).send({ error: "unknown job type" });
      }
      const job = enqueueJob(app.db, {
        type: body.type as (typeof allowed)[number],
        requestId: body.request_id,
        payload: body.payload,
      });
      return reply.code(201).send({ job });
    },
  );
}
