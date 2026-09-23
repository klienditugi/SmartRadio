import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyEnvOverrides, interpolateEnv, loadConfig, nextAcquisitionConfig, parseAppConfig } from "./config.js";
import { parseClassification, parseClassificationJson, safeParseClassification } from "./classification.js";

const exampleYamlObject = {
  server: { host: "127.0.0.1", port: 8788 },
  database: { path: "./data/subwave.sqlite" },
  paths: {
    secrets_dir: "./secrets",
    downloads: "./data/downloads",
    staging: "./data/staging",
    library: "./data/library",
  },
  files: { allowed_extensions: [".flac", ".mp3"], max_bytes: 1000 },
  auth: { admin_username: "admin", session_ttl_hours: 12, cookie_name: "subwave_session" },
  worker: { id: "worker-1", poll_ms: 250, lease_ms: 10000, max_attempts: 3 },
  policy: {
    require_electronic: true,
    require_station_match: true,
    min_confidence: 0.7,
    allowed_genres: ["techno"],
    blocked_artists: [],
    blocked_terms: [],
  },
  llm: {
    provider: "ollama",
    base_url: "http://127.0.0.1:11434",
    model: "configured-model",
    timeout_ms: 1000,
    verify_status: "verified",
  },
  library: {
    provider: "navidrome",
    base_url: "http://navidrome.example",
    username: "nd",
    client_name: "subwave-ai",
    api_version: "1.16.1",
    verify_status: "verified",
  },
  radio: {
    provider: "subwave",
    base_url: "http://radio.example/api",
    admin_user: "dj",
    verify_status: "verified",
  },
  acquisition: {
    provider: "slskd",
    base_url: "http://slskd.example",
    verify_status: "verified",
  },
};

describe("config", () => {
  it("parses a complete config object", () => {
    const cfg = parseAppConfig(exampleYamlObject);
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.llm.model).toBe("configured-model");
    expect(cfg.llm.provider).toBe("ollama");
    expect(cfg.library.provider).toBe("navidrome");
    expect(cfg.radio.provider).toBe("subwave");
    expect(cfg.acquisition.provider).toBe("slskd");
  });

  it("defaults omitted acquisition to enabled and unverified, and allows an empty URL", () => {
    const raw = structuredClone(exampleYamlObject);
    delete (raw.acquisition as { verify_status?: string }).verify_status;
    delete (raw.acquisition as { enabled?: boolean }).enabled;
    (raw.acquisition as { base_url: string }).base_url = "";
    const cfg = parseAppConfig(raw);
    expect(cfg.acquisition.enabled).toBe(true);
    expect(cfg.acquisition.verify_status).toBe("unverified");
    expect(cfg.acquisition.base_url).toBe("");
    expect(cfg.acquisition.provider).toBe("slskd");
  });

  it("clears acquisition verification when the URL, provider, or API key changes", () => {
    const current = parseAppConfig(exampleYamlObject).acquisition;
    expect(current.verify_status).toBe("verified");
    expect(nextAcquisitionConfig(current, { base_url: "http://other.example" }, false).verify_status).toBe("unverified");
    expect(nextAcquisitionConfig(current, { provider: "later" }, false).verify_status).toBe("unverified");
    expect(nextAcquisitionConfig(current, { enabled: false }, false).verify_status).toBe("unverified");
    expect(nextAcquisitionConfig(current, { enabled: true }, true).verify_status).toBe("unverified");
    expect(nextAcquisitionConfig(current, { enabled: true }, false).verify_status).toBe("verified");
  });

  it("rejects a missing LLM model (never default a model name)", () => {
    const bad = structuredClone(exampleYamlObject);
    (bad.llm as { model: string }).model = "";
    expect(() => parseAppConfig(bad)).toThrow();
  });

  it("interpolates ${ENV} placeholders", () => {
    const out = interpolateEnv({ model: "${OLLAMA_MODEL}" }, { OLLAMA_MODEL: "my-local-model" });
    expect(out).toEqual({ model: "my-local-model" });
  });

  it("applies explicit env overrides without using generic PORT/HOST", () => {
    const overridden = applyEnvOverrides(structuredClone(exampleYamlObject), {
      PORT: "80",
      HOST: "0.0.0.0",
      SUBWAVE_API_PORT: "9999",
      SUBWAVE_API_HOST: "127.0.0.1",
      OLLAMA_MODEL: "from-env",
    });
    expect((overridden.server as { port: number }).port).toBe(9999);
    expect((overridden.server as { host: string }).host).toBe("127.0.0.1");
    expect((overridden.llm as { model: string }).model).toBe("from-env");
  });

  it("loads yaml + secrets dir without embedding secret values in public parse", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-cfg-"));
    const secrets = path.join(dir, "secrets");
    mkdirSync(secrets);
    writeFileSync(path.join(secrets, "admin_password"), "test-admin-secret\n");
    const cfgPath = path.join(dir, "subwave.yaml");
    writeFileSync(
      cfgPath,
      `
server:
  host: "127.0.0.1"
  port: 8788
database:
  path: "${path.join(dir, "db.sqlite")}"
paths:
  secrets_dir: "${secrets}"
  downloads: "${path.join(dir, "dl")}"
  staging: "${path.join(dir, "st")}"
  library: "${path.join(dir, "lib")}"
llm:
  base_url: "http://127.0.0.1:11434"
  model: "test-model"
library:
  base_url: "http://navidrome.example"
  username: "nd"
radio:
  base_url: "http://radio.example/api"
  admin_user: "dj"
acquisition:
  provider: slskd
  base_url: "http://slskd.example"
`,
    );
    const loaded = loadConfig({ configPath: cfgPath });
    expect(loaded.secrets.adminPassword).toBe("test-admin-secret");
    expect(loaded.llm.model).toBe("test-model");
  });
});

describe("classification schema", () => {
  const valid = {
    artist: "A",
    title: "T",
    genre: "techno",
    subgenres: ["minimal"],
    electronic: true,
    station_match: true,
    confidence: 0.9,
    reason: "fits the policy",
  };

  it("accepts the verified classification shape", () => {
    expect(parseClassification(valid)).toEqual(valid);
  });

  it("rejects missing fields and out-of-range confidence", () => {
    expect(safeParseClassification({ ...valid, confidence: 1.2 }).success).toBe(false);
    expect(safeParseClassification({ ...valid, artist: "" }).success).toBe(false);
    expect(() => parseClassificationJson("not json")).toThrow(/not valid JSON/);
  });
});
