import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { RuntimeConfig } from "@subwave-ai/shared";
import type { Db } from "@subwave-ai/db";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerRequestRoutes } from "./routes/requests.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { seedAdmin, syncProviders } from "./context.js";

export type BuildAppOptions = {
  config: RuntimeConfig;
  db: Db;
  logger?: boolean;
};

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
  });
  app.decorate("config", opts.config);
  app.decorate("db", opts.db);

  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Sub Wave AI API",
        version: "0.1.0",
        description:
          "Backend foundation for Sub Wave AI Radio Automation. API is sync+enqueue; workers own LLM/library/acquire/radio/health.",
      },
      tags: [
        { name: "auth" },
        { name: "requests" },
        { name: "ops" },
        { name: "providers" },
        { name: "settings" },
        { name: "admin" },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/api/v1/docs",
  });

  await app.register(
    async (scoped) => {
      await registerHealthRoutes(scoped);
      await registerAuthRoutes(scoped);
      await registerRequestRoutes(scoped);
      await registerAdminRoutes(scoped);
    },
    { prefix: "/api/v1" },
  );

  await seedAdmin(opts.db, opts.config);
  syncProviders(opts.db, opts.config);
  await app.ready();
  return app;
}
