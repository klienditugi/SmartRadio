import type { FastifyInstance } from "fastify";
import { doctorReport } from "../context.js";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", { schema: { tags: ["ops"] } }, async () => ({
    status: "ok",
    service: "subwave-ai-api",
  }));

  app.get("/ready", { schema: { tags: ["ops"] } }, async (_request, reply) => {
    try {
      app.db.prepare("SELECT 1 AS ok").get();
      return { status: "ready" };
    } catch (err) {
      return reply.code(503).send({ status: "not_ready", error: (err as Error).message });
    }
  });

  app.get("/doctor", { schema: { tags: ["ops"] } }, async () => doctorReport(app.db, app.config));

  app.get("/openapi.json", { schema: { tags: ["ops"], hide: true } }, async () => app.swagger());
}
