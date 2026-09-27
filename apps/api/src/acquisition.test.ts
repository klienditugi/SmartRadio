import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listJobs } from "@subwave-ai/db";
import { loadConfig, resetDeprecatedSelectionWarning } from "@subwave-ai/shared";
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

  it("reads and writes selector policy, reports sources, and rejects a preferred value above the hard max", async () => {
    const ctx = await adminApp();
    fixtures.push(ctx.cleanup);
    const before = await ctx.app.inject({ method: "GET", url: "/api/v1/acquisition/settings", headers: ctx.headers });
    expect(before.statusCode).toBe(200);
    expect(before.json().selection).toMatchObject({
      preferred_max_file_size_mb: 30,
      max_file_size_mb: 200,
      preferred_max_duration_seconds: 720,
      max_duration_seconds: 1200,
      version_preference: "balanced",
      format_preference: "prefer_mp3",
    });
    expect(before.json().sources["acquisition.selection.preferred_max_file_size_mb"]).toEqual({ source: "default" });
    expect(before.json().sources["acquisition.selection.max_duration_seconds"]).toEqual({ source: "default" });
    expect(JSON.stringify(before.json())).not.toContain(API_KEY);

    const saved = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: {
        selection: {
          preferred_max_file_size_mb: 40,
          preferred_max_duration_seconds: 600,
          max_duration_seconds: 900,
          version_preference: "radio_edit",
          format_preference: "flac_only",
        },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().selection).toMatchObject({
      preferred_max_file_size_mb: 40,
      preferred_max_duration_seconds: 600,
      max_duration_seconds: 900,
      version_preference: "radio_edit",
      format_preference: "flac_only",
    });
    expect(saved.json().sources["acquisition.selection.preferred_max_file_size_mb"]).toEqual({ source: "yaml" });
    expect(ctx.app.config.acquisition.selection.format_preference).toBe("flac_only");
    expect(saved.json().sources["acquisition.selection.version_preference"]).toEqual({ source: "yaml" });
    expect(saved.json().sources["acquisition.selection.format_preference"]).toEqual({ source: "yaml" });

    const invalid = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { selection: { version_preference: "hip-hop", format_preference: "wav" } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatch(/version_preference/);
    expect(ctx.app.config.acquisition.selection.version_preference).toBe("radio_edit");

    const tooBig = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { selection: { preferred_max_file_size_mb: 250 } },
    });
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json().error).toMatch(/preferred_max_file_size_mb/);
    expect(ctx.app.config.acquisition.selection.preferred_max_file_size_mb).toBe(40);

    const tooLong = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { selection: { preferred_max_duration_seconds: 1000, max_duration_seconds: 900 } },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error).toMatch(/preferred_max_duration_seconds/);

    const disabled = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { selection: { max_duration_seconds: null, preferred_max_duration_seconds: 900 } },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().selection.max_duration_seconds).toBeNull();
    expect(disabled.json().selection.preferred_max_duration_seconds).toBe(900);
  });

  it("keeps an env-pinned preferred file size read-only", async () => {
    const previous = process.env.SLSKD_PREFERRED_MAX_FILE_SIZE_MB;
    process.env.SLSKD_PREFERRED_MAX_FILE_SIZE_MB = "28";
    const ctx = await adminApp();
    fixtures.push(() => {
      ctx.cleanup();
      if (previous === undefined) delete process.env.SLSKD_PREFERRED_MAX_FILE_SIZE_MB;
      else process.env.SLSKD_PREFERRED_MAX_FILE_SIZE_MB = previous;
    });
    const got = await ctx.app.inject({ method: "GET", url: "/api/v1/acquisition/settings", headers: ctx.headers });
    expect(got.json().selection.preferred_max_file_size_mb).toBe(28);
    expect(got.json().sources["acquisition.selection.preferred_max_file_size_mb"]).toEqual({
      source: "env",
      env: "SLSKD_PREFERRED_MAX_FILE_SIZE_MB",
    });
    const rejected = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { selection: { preferred_max_file_size_mb: 32 } },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toContain("SLSKD_PREFERRED_MAX_FILE_SIZE_MB");
    expect(ctx.app.config.acquisition.selection.preferred_max_file_size_mb).toBe(28);
    const same = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { selection: { preferred_max_file_size_mb: 28, version_preference: "remix" } },
    });
    expect(same.statusCode).toBe(200);
    expect(same.json().selection.version_preference).toBe("remix");
    expect(same.json().selection.preferred_max_file_size_mb).toBe(28);
  });

  it("keeps an env-pinned version preference read-only and rejects an invalid format", async () => {
    const previous = process.env.SLSKD_VERSION_PREFERENCE;
    process.env.SLSKD_VERSION_PREFERENCE = "original";
    const ctx = await adminApp();
    fixtures.push(() => {
      ctx.cleanup();
      if (previous === undefined) delete process.env.SLSKD_VERSION_PREFERENCE;
      else process.env.SLSKD_VERSION_PREFERENCE = previous;
    });
    const got = await ctx.app.inject({ method: "GET", url: "/api/v1/acquisition/settings", headers: ctx.headers });
    expect(got.json().selection.version_preference).toBe("original");
    expect(got.json().sources["acquisition.selection.version_preference"]).toEqual({
      source: "env",
      env: "SLSKD_VERSION_PREFERENCE",
    });
    expect(got.json().selection.format_preference).toBe("prefer_mp3");
    expect(got.json().sources["acquisition.selection.format_preference"]).toEqual({ source: "default" });
    const rejected = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { selection: { version_preference: "remix" } },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toContain("SLSKD_VERSION_PREFERENCE");
    expect(ctx.app.config.acquisition.selection.version_preference).toBe("original");
    const badFormat = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers: ctx.headers,
      payload: { selection: { format_preference: "lossy" } },
    });
    expect(badFormat.statusCode).toBe(400);
    expect(badFormat.json().error).toMatch(/format_preference/);
  });

  it("doctor warns that deprecated selector keys are ignored and does not translate them", async () => {
    resetDeprecatedSelectionWarning();
    const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-api-deprecation-"));
    const secrets = path.join(dir, "secrets");
    mkdirSync(secrets);
    writeFileSync(path.join(secrets, "admin_password"), "test-admin-password");
    writeFileSync(path.join(secrets, "session_secret"), "test-session-secret");
    const cfgPath = path.join(dir, "subwave.yaml");
    writeFileSync(
      cfgPath,
      `
server:
  host: "127.0.0.1"
  port: 8788
database:
  path: ":memory:"
paths:
  secrets_dir: "${secrets}"
  downloads: "${path.join(dir, "downloads")}"
  staging: "${path.join(dir, "staging")}"
  library: "${path.join(dir, "library")}"
acquisition:
  provider: slskd
  base_url: ""
  selection:
    extended_version_bonus: false
    lossless_preference: 0
`,
    );
    const previousVersion = process.env.SLSKD_EXTENDED_VERSION_BONUS;
    const previousFormat = process.env.SLSKD_LOSSLESS_PREFERENCE;
    process.env.SLSKD_EXTENDED_VERSION_BONUS = "true";
    process.env.SLSKD_LOSSLESS_PREFERENCE = "36";
    const config = loadConfig({ configPath: cfgPath });
    const db = testDb(config);
    const app = await buildApp({ config, db, serveWeb: false, logger: false });
    fixtures.push(() => {
      void app.close();
      if (previousVersion === undefined) delete process.env.SLSKD_EXTENDED_VERSION_BONUS;
      else process.env.SLSKD_EXTENDED_VERSION_BONUS = previousVersion;
      if (previousFormat === undefined) delete process.env.SLSKD_LOSSLESS_PREFERENCE;
      else process.env.SLSKD_LOSSLESS_PREFERENCE = previousFormat;
      rmSync(dir, { recursive: true, force: true });
    });
    expect(config.acquisition.selection.version_preference).toBe("balanced");
    expect(config.acquisition.selection.format_preference).toBe("prefer_mp3");
    const doctor = await app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(doctor.statusCode).toBe(200);
    const notes = doctor.json().notes.join("\n");
    expect(notes).toContain("extended_version_bonus is deprecated and ignored");
    expect(notes).toContain("acquisition.selection.version_preference");
    expect(notes).toContain("SLSKD_VERSION_PREFERENCE");
    expect(notes).toContain("lossless_preference is deprecated and ignored");
    expect(notes).toContain("acquisition.selection.format_preference");
    expect(notes).toContain("SLSKD_LOSSLESS_PREFERENCE is deprecated and ignored");
    expect(notes).toContain("SLSKD_FORMAT_PREFERENCE");
    const deprecation = (doctor.json().notes as string[]).filter((note) => note.includes("deprecated and ignored")).join("\n");
    expect(deprecation).not.toMatch(/password|api_key|secret|true|false|\b36\b|\b0\b/i);
  });
});
