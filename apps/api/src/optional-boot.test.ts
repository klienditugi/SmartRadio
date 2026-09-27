import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updateProviderHealth } from "@subwave-ai/db";
import { loadConfig } from "@subwave-ai/shared";
import { buildApp } from "./app.js";
import { testDb } from "./test-harness.js";

function emptyIntegrationConfig() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-boot-"));
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
llm:
  base_url: "\${OLLAMA_BASE_URL}"
  model: "\${OLLAMA_MODEL}"
library:
  base_url: "\${NAVIDROME_URL}"
  username: "\${NAVIDROME_USER}"
radio:
  base_url: "\${SUBWAVE_RADIO_URL}"
  admin_user: "\${SUBWAVE_RADIO_ADMIN_USER}"
`,
  );
  const config = loadConfig({
    configPath: cfgPath,
    env: {
      OLLAMA_BASE_URL: "",
      OLLAMA_MODEL: "",
      NAVIDROME_URL: "",
      NAVIDROME_USER: "",
      SUBWAVE_RADIO_URL: "",
      SUBWAVE_RADIO_ADMIN_USER: "",
    },
  });
  return {
    config,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("first boot without Navidrome or SUB/WAVE", () => {
  const fixtures: Array<() => void> = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.();
  });

  it("starts and reports not_configured, distinct from unreachable", async () => {
    const { config, cleanup } = emptyIntegrationConfig();
    fixtures.push(cleanup);
    const db = testDb(config);
    const app = await buildApp({ config, db, serveWeb: false });
    fixtures.push(() => {
      void app.close();
    });

    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe("ok");

    const ready = await app.inject({ method: "GET", url: "/api/v1/ready" });
    expect(ready.statusCode).toBe(200);

    const doctor = await app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(doctor.statusCode).toBe(200);
    const body = doctor.json();
    expect(body.ok).toBe(true);
    expect(body.integrations.llm.state).toBe("not_configured");
    expect(body.integrations.library.state).toBe("not_configured");
    expect(body.integrations.radio.state).toBe("not_configured");
    expect(body.integrations.library.probed).toBe(false);
    expect(body.integrations.library.detail).toBe("navidrome is not configured");
    expect(body.integrations.radio.detail).toBe("subwave radio is not configured");
    expect(body.integrations.llm.detail).toMatch(/not configured/);
    expect(JSON.stringify(body.integrations)).not.toMatch(/unreachable/);
    expect(body.config.integrations.library.state).toBe("not_configured");
    expect(body.ollama).toBe("external-only");

    app.config.library.base_url = "http://navidrome.example";
    app.config.library.username = "nd";
    app.config.secrets.navidromePassword = "secret";
    updateProviderHealth(db, "library-navidrome", {
      ok: false,
      state: "unreachable",
      detail: "connect ECONNREFUSED",
      verifyStatus: "verified",
      checked_at: "t",
    });
    const probed = await app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(probed.json().integrations.library.state).toBe("unreachable");
    expect(probed.json().integrations.radio.state).toBe("not_configured");

    app.config.library.base_url = "";
    const cleared = await app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(cleared.json().integrations.library.state).toBe("not_configured");
    expect(cleared.json().integrations.library.detail).not.toMatch(/unreachable/);
  });
});
