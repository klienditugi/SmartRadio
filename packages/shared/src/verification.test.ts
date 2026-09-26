import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig, resetDeprecatedVerifyStatusWarning } from "./config.js";
import { integrationConfigFingerprint } from "./verification.js";

function runtime() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-fp-"));
  const secrets = path.join(dir, "secrets");
  mkdirSync(secrets);
  writeFileSync(path.join(secrets, "navidrome_password"), "library-secret");
  writeFileSync(path.join(secrets, "subwave_admin_password"), "radio-secret");
  writeFileSync(path.join(secrets, "slskd_api_key"), "slskd-secret");
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
  downloads: "${path.join(dir, "dl")}"
  staging: "${path.join(dir, "st")}"
  library: "${path.join(dir, "lib")}"
llm:
  base_url: "http://ollama.example"
  model: "station-model"
  verify_status: verified
library:
  base_url: "http://navidrome.example"
  username: "nd"
  verify_status: verified
radio:
  base_url: "http://radio.example/api"
  admin_user: "dj"
  verify_status: verified
acquisition:
  enabled: true
  provider: slskd
  base_url: "http://slskd.example"
  verify_status: verified
`,
  );
  return loadConfig({ configPath: cfgPath, env: {} });
}

describe("stored verification fingerprint", () => {
  it("ignores yaml verified and changes when the secret changes, without embedding the secret", () => {
    resetDeprecatedVerifyStatusWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = runtime();
    expect(config.llm.verify_status).toBe("unverified");
    expect(config.library.verify_status).toBe("unverified");
    expect(config.radio.verify_status).toBe("unverified");
    expect(config.acquisition.verify_status).toBe("unverified");
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.filter((message) => message.includes("verify_status"))).toHaveLength(1);
    expect(messages.join("\n")).not.toMatch(/library-secret|radio-secret|slskd-secret/);
    runtime();
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("verify_status"))).toHaveLength(1);
    warn.mockRestore();

    const library = integrationConfigFingerprint(config, "library");
    expect(library).toMatch(/^[a-f0-9]{64}$/);
    expect(library).not.toContain("library-secret");
    const changedSecret = integrationConfigFingerprint(
      { ...config, secrets: { ...config.secrets, navidromePassword: "other-secret" } },
      "library",
    );
    expect(changedSecret).not.toBe(library);
    expect(changedSecret).not.toContain("other-secret");
    const changedUrl = integrationConfigFingerprint(
      { ...config, library: { ...config.library, base_url: "http://other.example" } },
      "library",
    );
    expect(changedUrl).not.toBe(library);
  });
});
