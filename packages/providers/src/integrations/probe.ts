import { createHash, randomBytes } from "node:crypto";
import type { IntegrationConnectionState } from "@subwave-ai/shared";
import { defaultFetch, joinUrl, type FetchLike } from "../http.js";

const PROBE_TIMEOUT_MS = 8_000;

export type IntegrationProbe = {
  state: Exclude<IntegrationConnectionState, "not_configured" | "configured_unverified">;
  detail: string;
};

type HttpRead =
  | { kind: "network" }
  | { kind: "http"; status: number; body: unknown };

function authRejected(status: number): boolean {
  return status === 401 || status === 403;
}

async function readHttp(res: Response): Promise<HttpRead> {
  const text = await res.text();
  if (!text) return { kind: "http", status: res.status, body: null };
  try {
    return { kind: "http", status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    return { kind: "http", status: res.status, body: null };
  }
}

async function getJson(fetchImpl: FetchLike, url: string | URL, init: RequestInit, timeoutMs: number): Promise<HttpRead> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return await readHttp(res);
  } catch {
    return { kind: "network" };
  }
}

function modelNames(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const names: string[] = [];
  for (const row of models) {
    if (!row || typeof row !== "object") continue;
    const record = row as { name?: unknown; model?: unknown };
    if (typeof record.name === "string" && record.name.trim()) names.push(record.name);
    if (typeof record.model === "string" && record.model.trim()) names.push(record.model);
  }
  return names;
}

/**
 * Read-only Ollama check: GET /api/tags. Confirms the configured model is listed.
 * Does not pull, install, or restart anything.
 */
export async function probeOllamaConnection(opts: {
  baseUrl: string;
  model: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<IntegrationProbe> {
  const fetchImpl = opts.fetch ?? defaultFetch();
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const result = await getJson(
    fetchImpl,
    joinUrl(opts.baseUrl, "/api/tags"),
    { method: "GET", headers: { accept: "application/json" } },
    timeoutMs,
  );
  if (result.kind === "network") return { state: "unreachable", detail: "Ollama unreachable" };
  if (authRejected(result.status)) return { state: "auth_failed", detail: "Ollama rejected the request" };
  if (result.status < 200 || result.status >= 300) return { state: "unreachable", detail: `Ollama GET /api/tags HTTP ${result.status}` };
  const wanted = opts.model.trim();
  if (!wanted || !modelNames(result.body).includes(wanted)) {
    return { state: "model_missing", detail: "configured model is not in the Ollama tag list" };
  }
  return { state: "ready", detail: "GET /api/tags includes the configured model" };
}

function navidromeRestBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/rest") ? trimmed : `${trimmed}/rest`;
}

/** Subsonic token auth. The password is not placed on the URL. */
export function navidromeAuthSearchParams(username: string, password: string, clientName: string, apiVersion: string): URLSearchParams {
  const salt = randomBytes(8).toString("hex");
  const token = createHash("md5").update(`${password}${salt}`).digest("hex");
  return new URLSearchParams({
    u: username,
    t: token,
    s: salt,
    v: apiVersion,
    c: clientName,
    f: "json",
  });
}

function subsonicStatus(body: unknown): { status: string; code: number | null } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const inner = (record["subsonic-response"] ?? record) as Record<string, unknown>;
  if (!inner || typeof inner !== "object" || typeof inner.status !== "string") return null;
  const error = inner.error as { code?: unknown } | undefined;
  const code = error && typeof error.code === "number" ? error.code : null;
  return { status: inner.status, code };
}

/**
 * Read-only Navidrome check: Subsonic GET /rest/ping with the existing token auth and f=json.
 * Ready only when the response status is ok.
 */
export async function probeNavidromeConnection(opts: {
  baseUrl: string;
  username: string;
  password: string;
  clientName?: string;
  apiVersion?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<IntegrationProbe> {
  const fetchImpl = opts.fetch ?? defaultFetch();
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const url = new URL(joinUrl(navidromeRestBase(opts.baseUrl), "ping"));
  const params = navidromeAuthSearchParams(opts.username, opts.password, opts.clientName ?? "subwave-ai", opts.apiVersion ?? "1.16.1");
  params.forEach((value, key) => url.searchParams.set(key, value));
  const result = await getJson(fetchImpl, url, { method: "GET", headers: { accept: "application/json" } }, timeoutMs);
  if (result.kind === "network") return { state: "unreachable", detail: "Navidrome unreachable" };
  if (authRejected(result.status)) return { state: "auth_failed", detail: "Navidrome rejected the username or password" };
  if (result.status < 200 || result.status >= 300) return { state: "unreachable", detail: `Navidrome ping HTTP ${result.status}` };
  const parsed = subsonicStatus(result.body);
  if (!parsed) return { state: "unreachable", detail: "Navidrome ping did not return a Subsonic status" };
  if (parsed.status === "ok") return { state: "ready", detail: "GET /rest/ping status ok" };
  if (parsed.code === 40 || parsed.code === 50 || parsed.status === "failed") {
    return { state: "auth_failed", detail: "Navidrome rejected the username or password" };
  }
  return { state: "unreachable", detail: "Navidrome ping was not ok" };
}

function onAir(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return (body as { status?: unknown }).status === "on-air";
}

/**
 * Read-only SUB/WAVE check.
 * Public GET /health must report status on-air (the verified health document).
 * Then one authenticated read-only admin call: GET /dj/search?q=a&limit=1.
 * Does not call /dj/say or /dj/queue-track.
 */
export async function probeSubwaveConnection(opts: {
  baseUrl: string;
  adminUser: string;
  adminPassword: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<IntegrationProbe> {
  const fetchImpl = opts.fetch ?? defaultFetch();
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const health = await getJson(
    fetchImpl,
    joinUrl(opts.baseUrl, "/health"),
    { method: "GET", headers: { accept: "application/json" } },
    timeoutMs,
  );
  if (health.kind === "network") return { state: "unreachable", detail: "SUB/WAVE unreachable" };
  if (health.status < 200 || health.status >= 300) return { state: "unreachable", detail: `SUB/WAVE GET /health HTTP ${health.status}` };
  if (!onAir(health.body)) return { state: "unhealthy", detail: "SUB/WAVE GET /health did not report status on-air" };

  const search = new URL(joinUrl(opts.baseUrl, "/dj/search"));
  search.searchParams.set("q", "a");
  search.searchParams.set("limit", "1");
  const authorization = `Basic ${Buffer.from(`${opts.adminUser}:${opts.adminPassword}`).toString("base64")}`;
  const admin = await getJson(
    fetchImpl,
    search,
    { method: "GET", headers: { accept: "application/json", authorization } },
    timeoutMs,
  );
  if (admin.kind === "network") return { state: "unreachable", detail: "SUB/WAVE admin search unreachable" };
  if (authRejected(admin.status)) return { state: "auth_failed", detail: "SUB/WAVE rejected the admin credentials" };
  if (admin.status < 200 || admin.status >= 300) return { state: "unreachable", detail: `SUB/WAVE GET /dj/search HTTP ${admin.status}` };
  return { state: "ready", detail: "GET /health status on-air and GET /dj/search succeeded" };
}
