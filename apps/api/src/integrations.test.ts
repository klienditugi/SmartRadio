import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listIntegrationChecks } from "@subwave-ai/db";
import { createProviders } from "@subwave-ai/providers";
import { loadConfig, resetDeprecatedVerifyStatusWarning, SECRET_FILES } from "@subwave-ai/shared";
import { buildApp } from "./app.js";
import { testConfig, testDb } from "./test-harness.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function adminApp(config: { config: ReturnType<typeof testConfig>["config"]; cleanup: () => void } = testConfig()) {
  const db = testDb(config.config);
  const app = await buildApp({ config: config.config, db, serveWeb: false, logger: false });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "test-admin-password" },
  });
  expect(login.statusCode).toBe(200);
  const token = (login.json() as { token: string }).token;
  return {
    app,
    headers: { authorization: `Bearer ${token}` },
    cleanup: () => {
      vi.unstubAllGlobals();
      void app.close();
      config.cleanup();
    },
  };
}

function upgradeConfig() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-upgrade-"));
  const secrets = path.join(dir, "secrets");
  mkdirSync(secrets);
  writeFileSync(path.join(secrets, "admin_password"), "test-admin-password");
  writeFileSync(path.join(secrets, "session_secret"), "test-session-secret");
  writeFileSync(path.join(secrets, "navidrome_password"), "library-secret");
  writeFileSync(path.join(secrets, "subwave_admin_password"), "radio-secret");
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
llm:
  base_url: "http://ollama.example"
  model: "station-model"
library:
  base_url: "http://navidrome.example"
  username: "nd"
radio:
  base_url: "http://radio.example/api"
  admin_user: "dj"
acquisition:
  provider: slskd
  base_url: ""
`,
  );
  const prev = process.env.SUBWAVE_CONFIG;
  process.env.SUBWAVE_CONFIG = cfgPath;
  const config = loadConfig({ configPath: cfgPath });
  return {
    config,
    cleanup: () => {
      if (prev === undefined) delete process.env.SUBWAVE_CONFIG;
      else process.env.SUBWAVE_CONFIG = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("integration test-connection", () => {
  const fixtures: Array<() => void> = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.();
  });

  it("requires admin and never returns secrets", async () => {
    const ctx = await adminApp();
    fixtures.push(ctx.cleanup);
    const anon = await ctx.app.inject({ method: "GET", url: "/api/v1/llm/status" });
    expect(anon.statusCode).toBe(401);
    const status = await ctx.app.inject({ method: "GET", url: "/api/v1/llm/status", headers: ctx.headers });
    expect(status.statusCode).toBe(200);
    expect(JSON.stringify(status.json())).not.toMatch(/password|secret|api_key/i);
  });

  it("lets only test-connection write verified, and records probe failures as unverified", async () => {
    const loaded = upgradeConfig();
    const ctx = await adminApp(loaded);
    fixtures.push(ctx.cleanup);
    expect(ctx.app.config.llm.verify_status).toBe("unverified");

    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      calls.push(`${init?.method ?? "GET"} ${href}`);
      if (href.includes("/api/pull") || href.includes("/dj/say") || href.includes("/dj/queue-track")) {
        throw new Error("probe must stay read-only");
      }
      if (href.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "station-model" }] });
      if (href.includes("/rest/ping")) return jsonResponse({ "subsonic-response": { status: "ok", version: "1.16.1" } });
      if (href.endsWith("/health")) return jsonResponse({ status: "on-air" });
      if (href.includes("/dj/search")) return jsonResponse({ results: [] });
      return jsonResponse({ error: "unexpected" }, 500);
    });

    const saved = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: ctx.headers,
      payload: { config: { llm: { verify_status: "verified", model: "station-model" } } },
    });
    expect(saved.statusCode).toBe(400);
    expect(ctx.app.config.llm.verify_status).toBe("unverified");

    const before = await ctx.app.inject({ method: "GET", url: "/api/v1/llm/status", headers: ctx.headers });
    expect(before.json()).toMatchObject({
      state: "configured_unverified",
      probed: false,
      detail: "configured but unverified, run test connection",
    });
    expect(calls).toEqual([]);

    const ready = await ctx.app.inject({ method: "POST", url: "/api/v1/llm/test-connection", headers: ctx.headers });
    expect(ready.json()).toMatchObject({ ok: true, state: "ready" });
    expect(ctx.app.config.llm.verify_status).toBe("verified");
    expect(calls).toEqual(["GET http://ollama.example/api/tags"]);

    vi.stubGlobal("fetch", async () => jsonResponse({ models: [{ name: "other" }] }));
    const missing = await ctx.app.inject({ method: "POST", url: "/api/v1/llm/test-connection", headers: ctx.headers });
    expect(missing.json().state).toBe("model_missing");
    expect(ctx.app.config.llm.verify_status).toBe("unverified");

    vi.stubGlobal("fetch", async () => jsonResponse({}, 401));
    const auth = await ctx.app.inject({ method: "POST", url: "/api/v1/library/test-connection", headers: ctx.headers });
    expect(auth.json().state).toBe("auth_failed");
    expect(ctx.app.config.library.verify_status).toBe("unverified");
    expect(JSON.stringify(auth.json())).not.toContain("library-secret");

    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    const down = await ctx.app.inject({ method: "POST", url: "/api/v1/radio/test-connection", headers: ctx.headers });
    expect(down.json().state).toBe("unreachable");
    expect(ctx.app.config.radio.verify_status).toBe("unverified");
    expect(JSON.stringify(down.json())).not.toContain("radio-secret");
  });

  it("reports configured_unverified in doctor when filled settings omit verify_status", async () => {
    const loaded = upgradeConfig();
    const ctx = await adminApp(loaded);
    fixtures.push(ctx.cleanup);
    const doctor = await ctx.app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(doctor.json().integrations).toEqual({
      llm: { state: "configured_unverified", detail: "configured but unverified, run test connection", probed: false },
      library: { state: "configured_unverified", detail: "configured but unverified, run test connection", probed: false },
      radio: { state: "configured_unverified", detail: "configured but unverified, run test connection", probed: false },
      acquisition: { state: "not_configured", detail: "acquisition is missing base_url or API key", probed: false },
    });
    expect(doctor.json().notes.join("\n")).toContain("configured but unverified, run test connection");
    expect(ctx.app.config.llm.verify_status).toBe("unverified");
    expect(ctx.app.config.library.verify_status).toBe("unverified");
    expect(ctx.app.config.radio.verify_status).toBe("unverified");
  });

  it("treats an old verified example as configured_unverified until a stored test matches", async () => {
    resetDeprecatedVerifyStatusWarning();
    const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-old-yaml-"));
    const secrets = path.join(dir, "secrets");
    mkdirSync(secrets);
    writeFileSync(path.join(secrets, "admin_password"), "test-admin-password");
    writeFileSync(path.join(secrets, "session_secret"), "test-session-secret");
    writeFileSync(path.join(secrets, "navidrome_password"), "library-secret");
    writeFileSync(path.join(secrets, "subwave_admin_password"), "radio-secret");
    writeFileSync(path.join(secrets, "slskd_api_key"), "slskd-secret");
    const cfgPath = path.join(dir, "subwave.yaml");
    const fixture = readFileSync(new URL("./fixtures/old-subwave.example.yaml", import.meta.url), "utf8");
    writeFileSync(
      cfgPath,
      fixture
        .replace('path: "./data/subwave.sqlite"', `path: "${path.join(dir, "db.sqlite")}"`)
        .replace('secrets_dir: "./secrets"', `secrets_dir: "${secrets}"`)
        .replace('downloads: "./data/downloads"', `downloads: "${path.join(dir, "downloads")}"`)
        .replace('staging: "./data/staging"', `staging: "${path.join(dir, "staging")}"`)
        .replace('library: "./data/library"', `library: "${path.join(dir, "library")}"`),
    );
    const prev = process.env.SUBWAVE_CONFIG;
    process.env.SUBWAVE_CONFIG = cfgPath;
    const config = loadConfig({ configPath: cfgPath });
    const ctx = await adminApp({
      config,
      cleanup: () => {
        if (prev === undefined) delete process.env.SUBWAVE_CONFIG;
        else process.env.SUBWAVE_CONFIG = prev;
        rmSync(dir, { recursive: true, force: true });
      },
    });
    fixtures.push(ctx.cleanup);

    const fetch = vi.fn(async () => {
      throw new Error("adapter called");
    });
    vi.stubGlobal("fetch", fetch);
    const providers = createProviders(ctx.app.config, fetch);
    await providers.llm.health();
    await providers.library.health();
    await providers.radio.health();
    await providers.acquisition.health();
    await expect(providers.llm.classify({ text: "play something" })).rejects.toThrow("configured but unverified, run test connection");
    await expect(providers.library.search3("query")).rejects.toThrow("configured but unverified, run test connection");
    await expect(providers.acquisition.search("query", "search-1")).rejects.toThrow(/unverified/);
    expect(fetch).not.toHaveBeenCalled();

    const doctor = await ctx.app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(doctor.json().integrations).toMatchObject({
      llm: { state: "configured_unverified", detail: "configured but unverified, run test connection" },
      library: { state: "configured_unverified", detail: "configured but unverified, run test connection" },
      radio: { state: "configured_unverified", detail: "configured but unverified, run test connection" },
      acquisition: { state: "configured_unverified", detail: "configured but unverified, run test connection" },
    });
    expect(doctor.json().acquire_unavailable).toBe(true);
    for (const kind of ["llm", "library", "radio", "acquisition"]) {
      const status = await ctx.app.inject({ method: "GET", url: `/api/v1/${kind}/status`, headers: ctx.headers });
      expect(status.json()).toMatchObject({
        state: "configured_unverified",
        probed: false,
        detail: "configured but unverified, run test connection",
      });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(cfgPath, "utf8")).toMatch(/verify_status: verified/);

    vi.stubGlobal("fetch", async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "station-model" }] });
      if (href.includes("/rest/ping")) return jsonResponse({ "subsonic-response": { status: "ok", version: "1.16.1" } });
      throw new Error(`unexpected ${href}`);
    });
    const ready = await ctx.app.inject({ method: "POST", url: "/api/v1/llm/test-connection", headers: ctx.headers });
    expect(ready.json()).toMatchObject({ ok: true, state: "ready" });
    expect(ctx.app.config.llm.verify_status).toBe("verified");
    expect(ctx.app.config.library.verify_status).toBe("unverified");
    expect(readFileSync(cfgPath, "utf8")).toMatch(/verify_status: verified/);

    const changed = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: ctx.headers,
      payload: { config: { llm: { model: "other-model" } } },
    });
    expect(changed.statusCode).toBe(200);
    expect(ctx.app.config.llm.verify_status).toBe("unverified");
    const afterModel = await ctx.app.inject({ method: "GET", url: "/api/v1/llm/status", headers: ctx.headers });
    expect(afterModel.json()).toMatchObject({
      state: "configured_unverified",
      detail: "configured but unverified, run test connection",
      probed: false,
    });

    const libraryReady = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/library/test-connection",
      headers: ctx.headers,
    });
    expect(libraryReady.json()).toMatchObject({ ok: true, state: "ready" });
    expect(ctx.app.config.library.verify_status).toBe("verified");
    const rotated = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: ctx.headers,
      payload: { secrets: { navidrome_password: "rotated-library-secret" } },
    });
    expect(rotated.statusCode).toBe(200);
    expect(ctx.app.config.library.verify_status).toBe("unverified");
    expect(ctx.app.config.secrets.navidromePassword).toBe("rotated-library-secret");
    const afterSecret = await ctx.app.inject({ method: "GET", url: "/api/v1/library/status", headers: ctx.headers });
    expect(afterSecret.json()).toMatchObject({
      state: "configured_unverified",
      detail: "configured but unverified, run test connection",
    });
    expect(JSON.stringify(afterSecret.json())).not.toContain("rotated-library-secret");
    expect(JSON.stringify(afterSecret.json())).not.toContain("library-secret");
  });

  it("omits the fingerprint from responses and unverifies every integration when the hmac key rotates", async () => {
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(String(chunk));
        callback();
      },
    });
    const loaded = upgradeConfig();
    const db = testDb(loaded.config);
    const app = await buildApp({
      config: loaded.config,
      db,
      serveWeb: false,
      logger: { level: "info", stream },
    });
    fixtures.push(() => {
      void app.close();
      loaded.cleanup();
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "test-admin-password" },
    });
    const headers = { authorization: `Bearer ${(login.json() as { token: string }).token}` };
    vi.stubGlobal("fetch", async (url: string | URL) => {
      if (String(url).endsWith("/api/tags")) return jsonResponse({ models: [{ name: "station-model" }] });
      return jsonResponse({ error: "unexpected" }, 500);
    });

    const tested = await app.inject({ method: "POST", url: "/api/v1/llm/test-connection", headers });
    expect(tested.json()).toMatchObject({ ok: true, state: "ready" });
    expect(app.config.llm.verify_status).toBe("verified");
    const stored = listIntegrationChecks(db).find((row) => row.integration === "llm");
    expect(stored?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const fingerprint = stored?.fingerprint ?? "";
    const key = app.config.secrets.verificationHmacKey;
    expect(key?.length).toBe(32);
    const hidden = [fingerprint, "fingerprint", key?.toString("hex") ?? "", key?.toString("base64") ?? ""];

    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/llm/status", headers }),
      app.inject({ method: "GET", url: "/api/v1/library/status", headers }),
      app.inject({ method: "GET", url: "/api/v1/radio/status", headers }),
      app.inject({ method: "GET", url: "/api/v1/acquisition/status", headers }),
      app.inject({ method: "GET", url: "/api/v1/acquisition/settings", headers }),
      app.inject({ method: "GET", url: "/api/v1/setup", headers }),
      app.inject({ method: "GET", url: "/api/v1/settings", headers }),
      app.inject({ method: "GET", url: "/api/v1/doctor" }),
    ]);
    for (const response of [tested, ...responses]) {
      const text = `${response.body}${JSON.stringify(response.json())}`;
      for (const secret of hidden) {
        expect(secret.length).toBeGreaterThan(0);
        expect(text).not.toContain(secret);
      }
    }
    const logged = logs.join("\n");
    for (const secret of hidden) expect(logged).not.toContain(secret);

    const keyPath = path.join(app.config.paths.secrets_dir, SECRET_FILES.verificationHmacKey);
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    const rotated = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers,
      payload: { config: { llm: { timeout_ms: 120000 } } },
    });
    expect(rotated.statusCode).toBe(200);
    expect(app.config.llm.verify_status).toBe("unverified");
    expect(JSON.stringify(rotated.json())).not.toContain(fingerprint);
    const afterRotate = await app.inject({ method: "GET", url: "/api/v1/llm/status", headers });
    expect(afterRotate.json()).toMatchObject({
      state: "configured_unverified",
      detail: "configured but unverified, run test connection",
    });
    const doctor = await app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(doctor.json().integrations.llm.state).toBe("configured_unverified");
    expect(JSON.stringify(doctor.json())).not.toContain(fingerprint);

    unlinkSync(keyPath);
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers,
      payload: { config: { llm: { timeout_ms: 120000 } } },
    });
    expect(missing.statusCode).toBe(200);
    expect(app.config.llm.verify_status).toBe("unverified");
    expect(app.config.secrets.verificationHmacKey?.length).toBe(32);
    expect(app.config.secrets.verificationHmacKey?.equals(key as Buffer)).toBe(false);
  });
});
