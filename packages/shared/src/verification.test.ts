import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig, resetDeprecatedVerifyStatusWarning, type RuntimeConfig } from "./config.js";
import { SECRET_FILES } from "./secrets.js";
import { applyStoredVerification, integrationConfigFingerprint } from "./verification.js";

function runtime(): { config: RuntimeConfig; secretsDir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-fp-"));
  const secretsDir = path.join(dir, "secrets");
  mkdirSync(secretsDir);
  writeFileSync(path.join(secretsDir, "navidrome_password"), "library-secret");
  writeFileSync(path.join(secretsDir, "subwave_admin_password"), "radio-secret");
  writeFileSync(path.join(secretsDir, "slskd_api_key"), "slskd-secret");
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
  secrets_dir: "${secretsDir}"
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
  return { config: loadConfig({ configPath: cfgPath, env: {} }), secretsDir };
}

describe("stored verification fingerprint", () => {
  it("is an HMAC under verification_hmac_key and does not match when that key is missing or rotated", () => {
    resetDeprecatedVerifyStatusWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { config, secretsDir } = runtime();
    expect(config.llm.verify_status).toBe("unverified");
    const keyFile = statSync(path.join(secretsDir, SECRET_FILES.verificationHmacKey));
    expect(keyFile.size).toBe(32);
    expect(keyFile.mode & 0o777).toBe(0o600);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.join("\n")).not.toMatch(/library-secret|radio-secret|slskd-secret/);
    warn.mockRestore();

    const library = integrationConfigFingerprint(config, "library");
    expect(library).toMatch(/^[a-f0-9]{64}$/);
    expect(library).not.toContain("library-secret");
    expect(library).not.toBe(createHash("sha256").update("library-secret", "utf8").digest("hex"));
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

    const checks = [{ integration: "library", state: "ready", fingerprint: library as string, testedAt: 1 }];
    applyStoredVerification(config, checks);
    expect(config.library.verify_status).toBe("verified");

    const rotated = applyStoredVerification(
      { ...config, secrets: { ...config.secrets, verificationHmacKey: randomBytes(32) } },
      checks,
    );
    expect(rotated.library.verify_status).toBe("unverified");

    const missing = applyStoredVerification(
      { ...config, secrets: { ...config.secrets, verificationHmacKey: undefined } },
      checks,
    );
    expect(missing.library.verify_status).toBe("unverified");
    expect(integrationConfigFingerprint(missing, "library")).toBeNull();
  });
});
