import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

export function resolveWebDist(): string | undefined {
  if (process.env.SUBWAVE_WEB_DIST) {
    const explicit = path.resolve(process.env.SUBWAVE_WEB_DIST);
    if (fs.existsSync(path.join(explicit, "index.html"))) return explicit;
  }
  const candidates = [
    path.resolve(process.cwd(), "apps/web/dist"),
    path.resolve(process.cwd(), "../web/dist"),
    path.resolve(process.cwd(), "dist/web"),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, "index.html")));
}

export async function registerWebUi(app: FastifyInstance): Promise<void> {
  const dist = resolveWebDist();
  if (!dist) {
    app.log.info("web UI dist not found — API-only mode (build apps/web or set SUBWAVE_WEB_DIST)");
    return;
  }
  await app.register(fastifyStatic, {
    root: dist,
    prefix: "/",
    wildcard: false,
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });
}
