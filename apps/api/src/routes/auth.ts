import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, publicUser } from "../auth.js";

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await authenticate(request.server.db, request.server.config, request);
  if (!user) {
    await reply.code(401).send({ error: "unauthorized" });
    return;
  }
  request.user = publicUser(user);
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireUser(request, reply);
  if (reply.sent) return;
  if (request.user?.role !== "admin") {
    await reply.code(403).send({ error: "forbidden" });
  }
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { loginUser, logoutUser, setSessionCookie, clearSessionCookie, publicUser } = await import("../auth.js");

  app.post(
    "/auth/login",
    {
      schema: {
        tags: ["auth"],
        body: {
          type: "object",
          required: ["username", "password"],
          properties: {
            username: { type: "string" },
            password: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { username: string; password: string };
      const result = await loginUser(app.db, app.config, body.username, body.password);
      if (!result) {
        return reply.code(401).send({ error: "invalid credentials" });
      }
      setSessionCookie(reply, app.config, result.token);
      return { user: publicUser(result.user), token: result.token };
    },
  );

  app.post("/auth/logout", { schema: { tags: ["auth"] } }, async (request, reply) => {
    logoutUser(app.db, app.config, request);
    clearSessionCookie(reply, app.config);
    return { ok: true };
  });

  app.get("/auth/me", { schema: { tags: ["auth"] }, preHandler: requireUser }, async (request) => {
    return { user: request.user };
  });
}
