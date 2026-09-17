import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  createSession,
  deleteExpiredSessions,
  deleteSessionByTokenHash,
  findSessionByTokenHash,
  findUserById,
  findUserByUsername,
  type Db,
  type UserRow,
} from "@subwave-ai/db";
import type { RuntimeConfig } from "@subwave-ai/shared";

const BCRYPT_ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function hashToken(token: string, sessionSecret?: string): string {
  return createHash("sha256")
    .update(`${sessionSecret ?? ""}:${token}`)
    .digest("hex");
}

export function issueSessionToken(): string {
  return randomBytes(32).toString("hex");
}

function readBearer(header?: string): string | undefined {
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  if (!scheme || !token) return undefined;
  if (scheme.toLowerCase() !== "bearer") return undefined;
  return token;
}

export function readSessionToken(request: FastifyRequest, cookieName: string): string | undefined {
  const cookie = request.cookies[cookieName];
  if (cookie) return cookie;
  return readBearer(request.headers.authorization);
}

export async function authenticate(
  db: Db,
  config: RuntimeConfig,
  request: FastifyRequest,
): Promise<UserRow | null> {
  deleteExpiredSessions(db);
  const token = readSessionToken(request, config.auth.cookie_name);
  if (!token) return null;
  const tokenHash = hashToken(token, config.secrets.sessionSecret);
  const session = findSessionByTokenHash(db, tokenHash);
  if (!session || session.expires_at < Date.now()) return null;
  return findUserById(db, session.user_id) ?? null;
}

export async function loginUser(
  db: Db,
  config: RuntimeConfig,
  username: string,
  password: string,
): Promise<{ user: UserRow; token: string } | null> {
  const user = findUserByUsername(db, username);
  if (!user) {
    await bcrypt.compare(password, "$2a$10$invalidhashinvalidhashinvalidho");
    return null;
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return null;
  const token = issueSessionToken();
  const ttlMs = config.auth.session_ttl_hours * 60 * 60 * 1000;
  createSession(db, {
    userId: user.id,
    tokenHash: hashToken(token, config.secrets.sessionSecret),
    expiresAt: Date.now() + ttlMs,
  });
  return { user, token };
}

export function logoutUser(db: Db, config: RuntimeConfig, request: FastifyRequest): void {
  const token = readSessionToken(request, config.auth.cookie_name);
  if (!token) return;
  deleteSessionByTokenHash(db, hashToken(token, config.secrets.sessionSecret));
}

export function setSessionCookie(reply: FastifyReply, config: RuntimeConfig, token: string): void {
  const ttlMs = config.auth.session_ttl_hours * 60 * 60 * 1000;
  reply.setCookie(config.auth.cookie_name, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(ttlMs / 1000),
    secure: false,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: RuntimeConfig): void {
  reply.clearCookie(config.auth.cookie_name, { path: "/" });
}

export function publicUser(user: UserRow) {
  return { id: user.id, username: user.username, role: user.role };
}

export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
