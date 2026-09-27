import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { putSetting } from "@subwave-ai/db";
import { VERIFY_STATUS_WRITE_REJECTED } from "@subwave-ai/shared";
import { buildApp } from "./app.js";
import { testConfig, testDb } from "./test-harness.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pinnedConfig() {
  const previous = {
    model: process.env.OLLAMA_MODEL,
    url: process.env.SLSKD_URL,
  };
  process.env.OLLAMA_MODEL = "pinned-model";
  process.env.SLSKD_URL = "http://pinned-slskd.example";
  const fixture = testConfig();
  const restoreEnv = fixture.cleanup;
  fixture.cleanup = () => {
    restoreEnv();
    if (previous.model === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = previous.model;
    if (previous.url === undefined) delete process.env.SLSKD_URL;
    else process.env.SLSKD_URL = previous.url;
  };
  return fixture;
}

describe("A6 follow-ups", () => {
  const fixtures: Array<() => void> = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    while (fixtures.length) fixtures.pop()?.();
  });

  it("reports env pins and rejects a setup change to a pinned model", async () => {
    const loaded = pinnedConfig();
    const db = testDb(loaded.config);
    const app = await buildApp({ config: loaded.config, db, serveWeb: false, logger: false });
    fixtures.push(() => {
      void app.close();
      loaded.cleanup();
    });
    expect(app.config.llm.model).toBe("pinned-model");
    expect(app.config.field_sources?.["llm.model"]).toEqual({ source: "env", env: "OLLAMA_MODEL" });
    expect(app.config.field_sources?.["llm.base_url"]?.source).toBe("yaml");
    expect(app.config.field_sources?.["llm.timeout_ms"]?.source).toBe("default");

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "test-admin-password" },
    });
    const headers = { authorization: `Bearer ${(login.json() as { token: string }).token}` };

    const setup = await app.inject({ method: "GET", url: "/api/v1/setup" });
    const settings = await app.inject({ method: "GET", url: "/api/v1/settings", headers });
    expect(setup.json().sources["llm.model"]).toEqual({ source: "env", env: "OLLAMA_MODEL" });
    expect(settings.json().sources["llm.model"]).toEqual({ source: "env", env: "OLLAMA_MODEL" });
    expect(settings.json().sources["acquisition.base_url"]).toEqual({ source: "env", env: "SLSKD_URL" });
    expect(settings.json().config.llm.model).toBe("pinned-model");
    const sources = `${JSON.stringify(setup.json().sources)}${JSON.stringify(settings.json().sources)}`;
    expect(sources).not.toContain("pinned-model");
    expect(sources).not.toContain("test-admin-password");
    expect(`${setup.body}${settings.body}`).not.toContain("test-admin-password");
    expect(`${setup.body}${settings.body}`).not.toContain("test-session-secret");

    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers,
      payload: { config: { llm: { model: "other-model" } } },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toContain("OLLAMA_MODEL");
    expect(app.config.llm.model).toBe("pinned-model");
    expect(readFileSync(process.env.SUBWAVE_CONFIG ?? "", "utf8")).not.toContain("other-model");

    const same = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers,
      payload: { config: { llm: { model: "pinned-model", timeout_ms: 90_000 } } },
    });
    expect(same.statusCode).toBe(200);
    expect(app.config.llm.model).toBe("pinned-model");
    expect(app.config.llm.timeout_ms).toBe(90_000);

    const url = await app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers,
      payload: { base_url: "http://other-slskd.example" },
    });
    expect(url.statusCode).toBe(409);
    expect(url.json().error).toContain("SLSKD_URL");
    expect(app.config.acquisition.base_url).toBe("http://pinned-slskd.example");
  });

  it("rejects verify_status on every settings write and hides stored copies", async () => {
    const loaded = testConfig();
    const db = testDb(loaded.config);
    const app = await buildApp({ config: loaded.config, db, serveWeb: false, logger: false });
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

    const stored = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers,
      payload: { llm: { model: "nope", verify_status: "verified" } },
    });
    expect(stored.statusCode).toBe(400);
    expect(stored.json().error).toBe(VERIFY_STATUS_WRITE_REJECTED);

    const nested = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers,
      payload: { config: { library: { extra: { verify_status: "unverified" } } } },
    });
    expect(nested.statusCode).toBe(400);

    const acquisition = await app.inject({
      method: "PUT",
      url: "/api/v1/acquisition/settings",
      headers,
      payload: { verify_status: "unverified" },
    });
    expect(acquisition.statusCode).toBe(400);

    putSetting(db, "llm", { model: "kept", verify_status: "verified" });
    putSetting(db, "verify_status", "verified");
    putSetting(db, "nested", { wrapper: { verify_status: "verified", keep: true } });

    const settings = await app.inject({ method: "GET", url: "/api/v1/settings", headers });
    const doctor = await app.inject({ method: "GET", url: "/api/v1/doctor" });
    for (const body of [settings.json().settings, doctor.json().settings]) {
      expect(JSON.stringify(body)).not.toContain("verify_status");
      expect(body.llm.model).toBe("kept");
      expect(body.nested.wrapper.keep).toBe(true);
      expect(body.verify_status).toBeUndefined();
    }
  });

  it("uses the stored test-connection result for doctor config.integrations", async () => {
    const loaded = testConfig();
    const db = testDb(loaded.config);
    const app = await buildApp({ config: loaded.config, db, serveWeb: false, logger: false });
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
    vi.stubGlobal("fetch", async () => jsonResponse({ models: [{ name: "test-model" }] }));
    const tested = await app.inject({ method: "POST", url: "/api/v1/llm/test-connection", headers });
    expect(tested.json().state).toBe("ready");

    const doctor = await app.inject({ method: "GET", url: "/api/v1/doctor" });
    const body = doctor.json();
    expect(body.integrations.llm).toEqual({ state: "ready", detail: "ready", probed: true });
    expect(body.config.integrations.llm).toEqual(body.integrations.llm);
    expect(JSON.stringify(body.config.integrations)).not.toContain("health probe has not run");
  });
});
