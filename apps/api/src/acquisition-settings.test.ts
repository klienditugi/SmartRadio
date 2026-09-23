import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { testConfig, testDb } from "./test-harness.js";

const API_KEY = "test-slskd-api-key";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("acquisition settings API", () => {
  const fixtures: Array<() => void> = [];
  const calls: string[] = [];
  let serverBody: Record<string, unknown> = { isConnected: false, isLoggedIn: false };
  let applicationStatus = 200;

  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.();
    calls.length = 0;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function installFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        expect(init?.method ?? "GET").toBe("GET");
        const headers = new Headers(init?.headers);
        if (headers.get("X-API-Key") !== API_KEY) throw new Error("missing slskd API key header");
        const forbidden = ["/searches", "/transfers", "/downloads"];
        expect(forbidden.some((part) => url.includes(part))).toBe(false);
        if (url.endsWith("/application")) {
          if (applicationStatus !== 200) return jsonResponse(applicationStatus, { title: "no" });
          return jsonResponse(200, { version: "test" });
        }
        if (url.endsWith("/server")) return jsonResponse(200, serverBody);
        throw new Error(`unexpected slskd url ${url}`);
      }),
    );
  }

  async function adminApp() {
    const { config, cleanup } = testConfig();
    fixtures.push(cleanup);
    const app = await buildApp({ config, db: testDb(config), serveWeb: false });
    fixtures.push(() => {
      void app.close();
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "test-admin-password" },
    });
    expect(login.statusCode).toBe(200);
    const token = (login.json() as { token: string }).token;
    return { app, headers: { authorization: `Bearer ${token}` } };
  }

  it("stores a write-only API key and ignores a client verify_status", async () => {
    const { app, headers } = await adminApp();
    const anon = await app.inject({ method: "PUT", url: "/api/v1/acquisition/settings", payload: { enabled: true } });
    expect(anon.statusCode).toBe(401);

    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers,
      payload: {
        enabled: true,
        provider: "slskd",
        base_url: "http://slskd.example:5030",
        downloads: "/var/lib/station/downloads",
        library: "/var/lib/station/library",
        api_key: API_KEY,
        verify_status: "verified",
      },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json() as { api_key_configured: boolean; verify_status: string; enabled: boolean };
    expect(body.api_key_configured).toBe(true);
    expect(body.verify_status).toBe("unverified");
    expect(body.enabled).toBe(true);
    expect(put.json()).not.toHaveProperty("api_key");
    expect(JSON.stringify(put.json())).not.toContain(API_KEY);

    const short = await app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers,
      payload: { api_key: "too-short" },
    });
    expect(short.statusCode).toBe(400);
    expect(JSON.stringify(short.json())).not.toContain("too-short");

    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers,
      payload: { config: { acquisition: { verify_status: "verified", base_url: "http://slskd.example:5030" } } },
    });
    expect(setup.statusCode).toBe(200);
    expect(setup.json().config.acquisition.verify_status).toBe("unverified");
    expect(JSON.stringify(setup.json())).not.toContain(API_KEY);
  });

  it("marks verified only after application and server both report a logged-in session", async () => {
    installFetch();
    const { app, headers } = await adminApp();
    await app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers,
      payload: {
        enabled: true,
        provider: "slskd",
        base_url: "http://slskd.example:5030",
        api_key: API_KEY,
      },
    });

    serverBody = { isConnected: true, isLoggedIn: false };
    const status = await app.inject({ method: "GET", url: "/api/v1/acquisition/status", headers });
    expect(status.statusCode).toBe(200);
    expect(status.json().state).toBe("soulseek_not_logged_in");
    expect(status.json().verify_status).toBe("unverified");
    expect(calls.every((url) => url.endsWith("/application") || url.endsWith("/server"))).toBe(true);

    const notReady = await app.inject({ method: "POST", url: "/api/v1/acquisition/test-connection", headers });
    expect(notReady.json().state).toBe("soulseek_not_logged_in");
    expect(notReady.json().verify_status).toBe("unverified");

    serverBody = { isConnected: true, isLoggedIn: true };
    const ready = await app.inject({ method: "POST", url: "/api/v1/acquisition/test-connection", headers });
    expect(ready.json().state).toBe("ready");
    expect(ready.json().verify_status).toBe("verified");
    expect(ready.json().worker_reload_required).toBe(true);
    expect(JSON.stringify(ready.json())).not.toContain(API_KEY);

    const doctor = await app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(doctor.json().acquire_unavailable).toBe(false);

    const moved = await app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers,
      payload: { base_url: "http://slskd.example:5031" },
    });
    expect(moved.json().verify_status).toBe("unverified");

    applicationStatus = 401;
    const authFail = await app.inject({ method: "POST", url: "/api/v1/acquisition/test-connection", headers });
    expect(authFail.json().state).toBe("auth_failed");
    expect(authFail.json().verify_status).toBe("unverified");
    expect(JSON.stringify(authFail.json())).not.toContain(API_KEY);
    expect(calls.every((url) => url.endsWith("/application") || url.endsWith("/server"))).toBe(true);
  });

  it("does not probe when acquisition is disabled", async () => {
    installFetch();
    const { app, headers } = await adminApp();
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers,
      payload: { enabled: false, provider: "slskd", base_url: "http://slskd.example:5030", api_key: API_KEY },
    });
    expect(put.json().enabled).toBe(false);
    expect(put.json().verify_status).toBe("unverified");
    const before = calls.length;
    const status = await app.inject({ method: "GET", url: "/api/v1/acquisition/status", headers });
    expect(status.json().state).toBe("disabled");
    expect(calls.length).toBe(before);
    const doctor = await app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(doctor.json().acquire_unavailable).toBe(true);
  });
});
