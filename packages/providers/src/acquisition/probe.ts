import type { AcquisitionConnectionState } from "@subwave-ai/shared";
import { defaultFetch, joinUrl, type FetchLike } from "../http.js";

/** SoulseekClientStates (Soulseek.NET), used when slskd sends a numeric `state`. */
const CONNECTED_FLAG = 2;
const LOGGED_IN_FLAG = 8;

const PROBE_TIMEOUT_MS = 8_000;

export type SlskdProbeChecks = {
  reachable: boolean;
  auth_ok: boolean | null;
  application_healthy: boolean;
  soulseek_connected: boolean | null;
  soulseek_logged_in: boolean | null;
};

export type SlskdProbe = {
  state: Exclude<AcquisitionConnectionState, "disabled" | "not_configured">;
  checks: SlskdProbeChecks;
  detail: string;
};

export function apiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api/v0") ? trimmed : `${trimmed}/api/v0`;
}

export function acquisitionLiveProbeDecision(
  input: {
    enabled: boolean;
    provider: string;
    baseUrl: string;
    hasApiKey: boolean;
  },
  options?: { ignoreEnabled?: boolean },
): { probe: true } | { probe: false; state: "disabled" | "not_configured"; detail: string } {
  if (!options?.ignoreEnabled && !input.enabled) {
    return { probe: false, state: "disabled", detail: "acquisition is disabled" };
  }
  if (input.provider !== "slskd") {
    return { probe: false, state: "not_configured", detail: "live checks only support provider slskd" };
  }
  if (!input.baseUrl.trim() || !input.hasApiKey) {
    return { probe: false, state: "not_configured", detail: "acquisition is missing base_url or API key" };
  }
  return { probe: true };
}

function stateFromChecks(checks: SlskdProbeChecks): SlskdProbe["state"] {
  if (!checks.reachable) return "unreachable";
  if (checks.auth_ok === false) return "auth_failed";
  if (!checks.application_healthy) return "reachable";
  if (checks.soulseek_connected === false) return "soulseek_not_connected";
  if (checks.soulseek_connected !== true || checks.soulseek_logged_in === null) return "reachable";
  if (checks.soulseek_logged_in === false) return "soulseek_not_logged_in";
  return "ready";
}

function detailFor(state: SlskdProbe["state"]): string {
  switch (state) {
    case "unreachable":
      return "slskd unreachable";
    case "auth_failed":
      return "slskd rejected the API key";
    case "reachable":
      return "slskd responded but application health or Soulseek status is incomplete";
    case "soulseek_not_connected":
      return "Soulseek server is not connected";
    case "soulseek_not_logged_in":
      return "Soulseek server is connected but not logged in";
    case "ready":
      return "slskd application healthy and Soulseek is connected and logged in";
    default:
      return "slskd check incomplete";
  }
}

function readBool(record: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

function stateTokens(state: unknown): Set<string> | null {
  if (typeof state !== "string") return null;
  const tokens = state
    .split(/[,|]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return new Set(tokens);
}

/** Read Soulseek connection from real slskd server fields. Unknown stays null. */
export function readSoulseekServer(body: unknown): { connected: boolean | null; loggedIn: boolean | null } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { connected: null, loggedIn: null };
  }
  const record = body as Record<string, unknown>;
  let connected = readBool(record, "isConnected", "IsConnected");
  let loggedIn = readBool(record, "isLoggedIn", "IsLoggedIn");
  const tokens = stateTokens(record.state ?? record.State);
  if (connected === null && tokens) {
    if (tokens.has("Connected")) connected = true;
    else if (tokens.has("Disconnected") || tokens.has("Connecting") || tokens.has("Disconnecting")) connected = false;
  }
  if (loggedIn === null && tokens) {
    if (tokens.has("LoggedIn")) loggedIn = true;
    else if (
      tokens.has("LoggingIn") ||
      tokens.has("Disconnected") ||
      tokens.has("Connected") ||
      tokens.has("Connecting")
    ) {
      loggedIn = false;
    }
  }
  const numeric = record.state ?? record.State;
  if (typeof numeric === "number" && Number.isFinite(numeric)) {
    if (connected === null) connected = numeric === 0 ? false : (numeric & CONNECTED_FLAG) !== 0;
    if (loggedIn === null) loggedIn = (numeric & LOGGED_IN_FLAG) !== 0;
  }
  return { connected, loggedIn };
}

/** Healthy slskd `GET /application` includes a version string or version.current / version.full. */
export function isSlskdApplicationHealthy(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  const version = record.version ?? record.Version;
  if (typeof version === "string") return version.trim().length > 0;
  if (!version || typeof version !== "object" || Array.isArray(version)) return false;
  const versionRecord = version as Record<string, unknown>;
  const label = versionRecord.current ?? versionRecord.Current ?? versionRecord.full ?? versionRecord.Full;
  return typeof label === "string" && label.trim().length > 0;
}

type HttpRead =
  | { kind: "network" }
  | { kind: "http"; status: number; body: unknown };

async function readHttp(res: Response): Promise<HttpRead> {
  const text = await res.text();
  if (!text) return { kind: "http", status: res.status, body: null };
  try {
    return { kind: "http", status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    return { kind: "http", status: res.status, body: null };
  }
}

function authRejected(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Read-only slskd check: GET /api/v0/application and GET /api/v0/server.
 * Does not search, enqueue, or log the API key.
 */
export async function probeSlskdConnection(opts: {
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<SlskdProbe> {
  const fetchImpl = opts.fetch ?? defaultFetch();
  const root = apiRoot(opts.baseUrl);
  const headers: Record<string, string> = {
    accept: "application/json",
    "X-API-Key": opts.apiKey,
  };
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;

  const checks: SlskdProbeChecks = {
    reachable: false,
    auth_ok: null,
    application_healthy: false,
    soulseek_connected: null,
    soulseek_logged_in: null,
  };

  const finish = (): SlskdProbe => {
    const state = stateFromChecks(checks);
    return { state, checks, detail: detailFor(state) };
  };

  let application: HttpRead;
  try {
    const res = await fetchImpl(joinUrl(root, "/application"), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    application = await readHttp(res);
  } catch {
    return finish();
  }

  checks.reachable = true;
  if (application.kind === "network") return finish();
  if (authRejected(application.status)) {
    checks.auth_ok = false;
    return finish();
  }
  checks.auth_ok = true;
  if (application.status !== 200) return finish();
  checks.application_healthy = isSlskdApplicationHealthy(application.body);

  let server: HttpRead;
  try {
    const res = await fetchImpl(joinUrl(root, "/server"), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    server = await readHttp(res);
  } catch {
    return finish();
  }

  if (server.kind === "network") return finish();
  if (authRejected(server.status)) {
    checks.auth_ok = false;
    return finish();
  }
  if (server.status !== 200) return finish();
  const soulseek = readSoulseekServer(server.body);
  checks.soulseek_connected = soulseek.connected;
  checks.soulseek_logged_in = soulseek.loggedIn;
  return finish();
}
