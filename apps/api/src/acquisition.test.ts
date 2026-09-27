import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listJobs } from "@subwave-ai/db";
import { buildApp } from "./app.js";
import { testConfig, testDb } from "./test-harness.js";

const API_KEY = "slskd-secret-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const healthyApp = { version: { current: "0.22.5", full: "0.22.5.0" }, pendingRestart: false };

function stubSlskd(server: unknown, application: unknown = healthyApp, applicationStatus = 200) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    if (String(url).includes("/searches") || String(url).includes("/transfers")) {
      throw new Error("acquisition probe must not search or download");
    }
    if (String(url).endsWith("/server")) return jsonResponse(server);
    return jsonResponse(application, applicationStatus);
  });
  return calls;
}

async function adminApp() {
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs.push(String(chunk));
      callback();
    },
  });
  const { config, cleanup } = testConfig();
  const db = testDb(config);
  const app = await buildApp({
    config,
    db,
    serveWeb: false,
    logger: { level: "info", stream },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "test-admin-password" },
  });
  expect(login.statusCode).toBe(200);
  const token = (login.json() as { token: string }).token;
  return {
    app,
    db,
    config,
    logs,
    headers: { authorization: `Bearer ${token}` },
    cleanup: () => {
      vi.unstubAllGlobals();
      void app.close();
      cleanup();
    },
  };
}

describe("A6 acquisition settings", () => {
  const fixtures: Array<() => void> = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.();
  });

  it("requires admin and never returns the API key", async () => {
    const ctx = await adminApp();
    fixtures.push(ctx.cleanup);
    const anon = await ctx.app.inject({ method: "GET", url: "/api/v1/acquisition/settings" });
    expect(anon.statusCode).toBe(401);

    const saved = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: {
        enabled: true,
        provider: "slskd",
        base_url: "http://slskd.example:5030",
        paths: { downloads: "/music/downloads", library: "/music/library" },
        slskd_api_key: API_KEY,
      },
    });
    expect(saved.statusCode).toBe(200);
    const body = saved.json() as {
      enabled: boolean;
      verify_status: string;
      secrets_present: { slskd_api_key: boolean };
      paths: { downloads: string; library: string };
    };
    expect(body.enabled).toBe(true);
    expect(body.verify_status).toBe("unverified");
    expect(body.secrets_present.slskd_api_key).toBe(true);
    expect(body.paths).toEqual({ downloads: "/music/downloads", library: "/music/library" });
    expect(JSON.stringify(body)).not.toContain(API_KEY);
    expect(readFileSync(`${ctx.config.paths.secrets_dir}/slskd_api_key`, "utf8")).toContain(API_KEY);
    const yaml = readFileSync(process.env.SUBWAVE_CONFIG ?? "", "utf8");
    expect(yaml).not.toContain(API_KEY);
    expect(yaml).toContain("enabled: true");
    const logged = ctx.logs.join("");
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain(API_KEY);
    expect(logged).toContain("acquisition settings saved");

    const rejected = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { verify_status: "verified" },
    });
    expect(rejected.statusCode).toBe(400);
    expect(ctx.app.config.acquisition.verify_status).toBe("unverified");

    const credentials = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { soulseek_username: "user", soulseek_password: "pass" },
    });
    expect(credentials.statusCode).toBe(400);
  });

  it("persists enabled through setup and does not verify from a saved URL and key", async () => {
    const ctx = await adminApp();
    fixtures.push(ctx.cleanup);
    const setup = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: ctx.headers,
      payload: {
        config: {
          acquisition: { enabled: false, provider: "slskd", base_url: "http://slskd.example", verify_status: "verified" },
        },
        secrets: { slskd_api_key: API_KEY },
      },
    });
    expect(setup.statusCode).toBe(400);
    expect(ctx.app.config.acquisition.verify_status).not.toBe("verified");

    const ok = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: ctx.headers,
      payload: {
        config: { acquisition: { enabled: false, base_url: "http://slskd.example" } },
        secrets: { slskd_api_key: API_KEY },
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().config.acquisition.enabled).toBe(false);
    expect(ok.json().config.acquisition.verify_status).toBe("unverified");
    expect(ok.json().config.secrets_present.slskd_api_key).toBe(true);
    expect(JSON.stringify(ok.json())).not.toContain(API_KEY);
  });

  it("verifies only after application health and Soulseek login succeed", async () => {
    const ctx = await adminApp();
    fixtures.push(ctx.cleanup);
    await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { enabled: true, base_url: "http://slskd.example", slskd_api_key: API_KEY },
    });

    let calls = stubSlskd({ isConnected: true, isLoggedIn: false, state: "Connected" });
    const failed = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/acquisition/test-connection",
      headers: ctx.headers,
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().state).toBe("soulseek_not_logged_in");
    expect(failed.json().settings.verify_status).toBe("unverified");
    expect(calls).toEqual([
      "GET http://slskd.example/api/v0/application",
      "GET http://slskd.example/api/v0/server",
    ]);
    expect(JSON.stringify(failed.json())).not.toContain(API_KEY);

    calls = stubSlskd({ isConnected: true, isLoggedIn: true, state: "Connected, LoggedIn" });
    const passed = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/acquisition/test-connection",
      headers: ctx.headers,
    });
    expect(passed.statusCode).toBe(200);
    expect(passed.json().ok).toBe(true);
    expect(passed.json().state).toBe("ready");
    expect(passed.json().settings.verify_status).toBe("verified");
    expect(calls).toEqual([
      "GET http://slskd.example/api/v0/application",
      "GET http://slskd.example/api/v0/server",
    ]);
    expect(listJobs(ctx.db).map((job) => job.type)).not.toContain("download");
    expect(listJobs(ctx.db).map((job) => job.type)).not.toContain("search_acquisition");

    calls = stubSlskd({ isConnected: false, isLoggedIn: false, state: "Disconnected" });
    const status = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/acquisition/status",
      headers: ctx.headers,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().probed).toBe(true);
    expect(status.json().state).toBe("ready");
    expect(status.json().settings.verify_status).toBe("verified");
    expect(calls).toEqual([]);
  });

  it("reports disabled and not_configured from config without probing", async () => {
    const ctx = await adminApp();
    fixtures.push(ctx.cleanup);
    const calls = stubSlskd({ isConnected: true, isLoggedIn: true });
    const missing = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/acquisition/status",
      headers: ctx.headers,
    });
    expect(missing.json().state).toBe("not_configured");
    expect(missing.json().probed).toBe(false);
    expect(missing.json().checks).toBeNull();
    expect(calls).toHaveLength(0);

    await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { enabled: false, base_url: "http://slskd.example", slskd_api_key: API_KEY },
    });
    const disabled = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/acquisition/status",
      headers: ctx.headers,
    });
    expect(disabled.json().state).toBe("disabled");
    expect(disabled.json().probed).toBe(false);
    expect(calls).toHaveLength(0);

    const doctorOff = await ctx.app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(doctorOff.json().acquire_unavailable).toBe(true);
    expect(JSON.stringify(doctorOff.json())).not.toContain(API_KEY);
  });

  it("treats enabled, missing key, unverified, and non-slskd as unavailable", async () => {
    const ctx = await adminApp();
    fixtures.push(ctx.cleanup);
    ctx.app.config.acquisition.enabled = true;
    ctx.app.config.acquisition.provider = "slskd";
    ctx.app.config.acquisition.base_url = "http://slskd.example";
    ctx.app.config.acquisition.verify_status = "verified";
    ctx.app.config.secrets.slskdApiKey = API_KEY;
    const ready = await ctx.app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(ready.json().acquire_unavailable).toBe(false);
    expect(JSON.stringify(ready.json())).not.toContain(API_KEY);

    ctx.app.config.acquisition.enabled = false;
    const disabled = await ctx.app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(disabled.json().acquire_unavailable).toBe(true);

    ctx.app.config.acquisition.enabled = true;
    ctx.app.config.secrets.slskdApiKey = "";
    const missingKey = await ctx.app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(missingKey.json().acquire_unavailable).toBe(true);

    ctx.app.config.secrets.slskdApiKey = API_KEY;
    ctx.app.config.acquisition.verify_status = "unverified";
    const unverified = await ctx.app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(unverified.json().acquire_unavailable).toBe(true);

    ctx.app.config.acquisition.verify_status = "verified";
    ctx.app.config.acquisition.provider = "other-daemon";
    const calls = stubSlskd({ isConnected: true, isLoggedIn: true });
    const other = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/acquisition/status",
      headers: ctx.headers,
    });
    expect(other.json().state).toBe("not_configured");
    expect(other.json().probed).toBe(false);
    expect(calls).toHaveLength(0);
    const doctor = await ctx.app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(doctor.json().acquire_unavailable).toBe(true);
  });

  it("clears verification when the base URL changes and keeps it when only paths change", async () => {
    const ctx = await adminApp();
    fixtures.push(ctx.cleanup);
    await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { enabled: true, base_url: "http://slskd.example", slskd_api_key: API_KEY },
    });
    stubSlskd({ isConnected: true, isLoggedIn: true });
    const passed = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/acquisition/test-connection",
      headers: ctx.headers,
    });
    expect(passed.json().settings.verify_status).toBe("verified");

    const paths = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { paths: { downloads: "/tmp/downloads", library: "/tmp/library" } },
    });
    expect(paths.json().verify_status).toBe("verified");
    expect(paths.json().paths.library).toBe("/tmp/library");

    const moved = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { base_url: "http://other.example" },
    });
    expect(moved.json().verify_status).toBe("unverified");
    expect(JSON.stringify(moved.json())).not.toContain(API_KEY);
  });

  it("reports auth_failed and unreachable from the live probe", async () => {
    const ctx = await adminApp();
    fixtures.push(ctx.cleanup);
    await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { enabled: true, base_url: "http://slskd.example", slskd_api_key: API_KEY },
    });
    stubSlskd({}, { title: "nope" }, 401);
    const auth = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/acquisition/test-connection",
      headers: ctx.headers,
    });
    expect(auth.json().state).toBe("auth_failed");
    expect(auth.json().settings.verify_status).toBe("unverified");
    expect(JSON.stringify(auth.json())).not.toContain(API_KEY);

    vi.stubGlobal("fetch", async () => {
      throw new Error(`boom ${API_KEY}`);
    });
    const down = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/acquisition/test-connection",
      headers: ctx.headers,
    });
    expect(down.json().state).toBe("unreachable");
    expect(down.json().probed).toBe(true);
    expect(JSON.stringify(down.json())).not.toContain(API_KEY);
    expect(ctx.logs.join("")).not.toContain(API_KEY);
    vi.stubGlobal("fetch", async () => {
      throw new Error("status must not probe");
    });
    const stored = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/acquisition/status",
      headers: ctx.headers,
    });
    expect(stored.json().state).toBe("unreachable");
    expect(stored.json().settings.verify_status).toBe("unverified");
  });
});
