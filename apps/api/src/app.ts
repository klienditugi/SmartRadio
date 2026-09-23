import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { RuntimeConfig } from "@subwave-ai/shared";
import type { Db } from "@subwave-ai/db";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerRequestRoutes } from "./routes/requests.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerOpsRoutes } from "./routes/ops.js";
import { registerSetupRoutes } from "./routes/setup.js";
import { registerAcquisitionRoutes } from "./routes/acquisition.js";
import { seedAdmin, syncProviders } from "./context.js";
import { registerWebUi } from "./web.js";

export type BuildAppOptions = {
  config: RuntimeConfig;
  db: Db;
  logger?: boolean | Record<string, unknown>;
  serveWeb?: boolean;
};

const SECRET_LOG_REDACT = [
  "req.body.slskd_api_key",
  "req.body.secrets.slskd_api_key",
  'req.headers["x-api-key"]',
];

function buildLogger(logger: BuildAppOptions["logger"]): boolean | Record<string, unknown> {
  if (!logger) return false;
  if (logger === true) return { redact: SECRET_LOG_REDACT };
  return { ...logger, redact: SECRET_LOG_REDACT };
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLogger(opts.logger),
  });
  app.decorate("config", opts.config);
  app.decorate("db", opts.db);

  await app.register(cookie);
  const origin = process.env.SUBWAVE_WEB_ORIGIN;
  if (origin) {
    await app.register(cors, {
      origin,
      credentials: true,
    });
  }
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Sub Wave AI API",
        version: "0.4.0",
        description:
          "Sub Wave AI Radio Automation. API is sync+enqueue; workers own LLM/library/acquire/radio/health. Web UI is served from the same origin when apps/web/dist is present.",
      },
      tags: [
        { name: "auth" },
        { name: "requests" },
        { name: "ops" },
        { name: "providers" },
        { name: "settings" },
        { name: "acquisition" },
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
      await registerSetupRoutes(scoped);
      await registerAcquisitionRoutes(scoped);
      await registerRequestRoutes(scoped);
      await registerAdminRoutes(scoped);
      await registerOpsRoutes(scoped);
    },
    { prefix: "/api/v1" },
  );

  await seedAdmin(opts.db, opts.config);
  syncProviders(opts.db, opts.config);
  if (opts.serveWeb !== false) {
    await registerWebUi(app);
  }
  await app.ready();
  return app;
}
