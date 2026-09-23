import type { RuntimeConfig } from "@subwave-ai/shared";

export const ACQUISITION_CONNECTION_STATES = [
  "disabled",
  "not_configured",
  "unreachable",
  "auth_failed",
  "reachable",
  "soulseek_not_connected",
  "soulseek_not_logged_in",
  "ready",
] as const;

export type AcquisitionConnectionState = (typeof ACQUISITION_CONNECTION_STATES)[number];

export type AcquisitionProbeResult = {
  state: AcquisitionConnectionState;
  detail: string;
  checked_at: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function checkedNow(): string {
  return new Date().toISOString();
}

function slskdRoot(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/api/v0") ? trimmed : `${trimmed}/api/v0`;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Map a slskd `GET /api/v0/server` JSON body. Missing flags are not treated as logged in. */
export function interpretSlskdServer(body: unknown): {
  state: "reachable" | "soulseek_not_connected" | "soulseek_not_logged_in" | "ready";
  detail: string;
} {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const connected = flag(rec.isConnected) ?? flag(rec.IsConnected);
  const loggedIn = flag(rec.isLoggedIn) ?? flag(rec.IsLoggedIn);
  if (connected === false) {
    return { state: "soulseek_not_connected", detail: "slskd is up. Soulseek is not connected." };
  }
  if (connected === true && loggedIn === false) {
    return { state: "soulseek_not_logged_in", detail: "Soulseek is connected but not logged in." };
  }
  if (connected === true && loggedIn === true) {
    return { state: "ready", detail: "slskd responded and Soulseek is connected and logged in." };
  }
  return {
    state: "reachable",
    detail: "GET /api/v0/application succeeded. Soulseek session was not confirmed.",
  };
}

/**
 * Read-only slskd probe: GET /api/v0/application and GET /api/v0/server.
 * Does not search or enqueue downloads. Does not include the API key in errors.
 */
export async function probeSlskd(opts: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
}): Promise<AcquisitionProbeResult> {
  const checked_at = checkedNow();
  const fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  let root: string;
  try {
    const url = new URL(opts.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { state: "unreachable", detail: "slskd URL must be an http(s) URL.", checked_at };
    }
    if (url.username || url.password) {
      return { state: "unreachable", detail: "slskd URL must not include credentials.", checked_at };
    }
    root = slskdRoot(`${url.origin}${url.pathname}`);
  } catch {
    return { state: "unreachable", detail: "slskd URL is not absolute.", checked_at };
  }

  const headers = {
    Accept: "application/json",
    "X-API-Key": opts.apiKey,
  };

  const call = async (path: "/application" | "/server"): Promise<{ status: number; body: unknown } | "network"> => {
    try {
      const res = await fetchImpl(`${root}${path}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      if (!text) return { status: res.status, body: {} };
      try {
        return { status: res.status, body: JSON.parse(text) as unknown };
      } catch {
        return { status: res.status, body: null };
      }
    } catch {
      return "network";
    }
  };

  const application = await call("/application");
  if (application === "network") {
    return { state: "unreachable", detail: "slskd did not respond to GET /api/v0/application.", checked_at };
  }
  if (application.status === 401 || application.status === 403) {
    return { state: "auth_failed", detail: `slskd rejected the API key (HTTP ${application.status}).`, checked_at };
  }
  if (application.status < 200 || application.status >= 300 || application.body === null) {
    return { state: "unreachable", detail: "GET /api/v0/application did not return JSON.", checked_at };
  }

  const server = await call("/server");
  if (server === "network") {
    return {
      state: "reachable",
      detail: "GET /api/v0/application succeeded. GET /api/v0/server did not respond.",
      checked_at,
    };
  }
  if (server.status === 401 || server.status === 403) {
    return { state: "auth_failed", detail: `slskd rejected the API key (HTTP ${server.status}).`, checked_at };
  }
  if (server.status < 200 || server.status >= 300 || server.body === null) {
    return {
      state: "reachable",
      detail: "GET /api/v0/application succeeded. GET /api/v0/server did not return JSON.",
      checked_at,
    };
  }
  return { ...interpretSlskdServer(server.body), checked_at };
}

export async function assessAcquisition(config: RuntimeConfig, fetchImpl?: FetchLike): Promise<AcquisitionProbeResult> {
  const checked_at = checkedNow();
  if (!config.acquisition.enabled) {
    return { state: "disabled", detail: "Acquisition is disabled.", checked_at };
  }
  if (config.acquisition.provider !== "slskd") {
    return {
      state: "not_configured",
      detail: "Live checks are implemented for the slskd provider.",
      checked_at,
    };
  }
  const baseUrl = config.acquisition.base_url.trim();
  const apiKey = (config.secrets.slskdApiKey ?? "").trim();
  if (!baseUrl || !apiKey) {
    return {
      state: "not_configured",
      detail: "Set the slskd URL and API key. Soulseek username and password stay in slskd.",
      checked_at,
    };
  }
  return probeSlskd({ baseUrl, apiKey, fetchImpl });
}
