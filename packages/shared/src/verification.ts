import { createHash } from "node:crypto";
import type { RuntimeConfig } from "./config.js";

export const INTEGRATION_NAMES = ["llm", "library", "radio", "acquisition"] as const;
export type IntegrationName = (typeof INTEGRATION_NAMES)[number];

/** A test-connection row. `fingerprint` covers the config that was tested, never the secret itself. */
export type StoredIntegrationCheck = {
  integration: string;
  state: string;
  fingerprint: string;
  testedAt: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secretHash(secret: string | undefined): string {
  return sha256(secret?.trim() ?? "");
}

/**
 * Identity of the settings a test-connection ran against.
 * Includes URL, user, model, provider, and a hash of the secret. The secret is not in the result.
 */
export function integrationConfigFingerprint(config: RuntimeConfig, integration: IntegrationName): string {
  const material =
    integration === "llm"
      ? {
          integration,
          provider: config.llm.provider,
          base_url: config.llm.base_url.trim(),
          model: config.llm.model.trim(),
          secret_sha256: secretHash(""),
        }
      : integration === "library"
        ? {
            integration,
            provider: config.library.provider,
            base_url: config.library.base_url.trim(),
            username: config.library.username.trim(),
            client_name: config.library.client_name,
            api_version: config.library.api_version,
            secret_sha256: secretHash(config.secrets.navidromePassword),
          }
        : integration === "radio"
          ? {
              integration,
              provider: config.radio.provider,
              base_url: config.radio.base_url.trim(),
              admin_user: config.radio.admin_user.trim(),
              secret_sha256: secretHash(config.secrets.subwaveAdminPassword),
            }
          : {
              integration,
              provider: config.acquisition.provider.trim(),
              base_url: config.acquisition.base_url.trim(),
              enabled: config.acquisition.enabled ? "true" : "false",
              secret_sha256: secretHash(config.secrets.slskdApiKey),
            };
  return sha256(JSON.stringify(material));
}

export function findMatchingIntegrationCheck(
  config: RuntimeConfig,
  integration: IntegrationName,
  checks: readonly StoredIntegrationCheck[],
): StoredIntegrationCheck | null {
  const check = checks.find((row) => row.integration === integration);
  if (!check) return null;
  if (check.fingerprint !== integrationConfigFingerprint(config, integration)) return null;
  return check;
}

/** `verified` only when a stored result is `ready` for the current config fingerprint. */
export function applyStoredVerification<T extends RuntimeConfig>(config: T, checks: readonly StoredIntegrationCheck[]): T {
  for (const integration of INTEGRATION_NAMES) {
    const check = findMatchingIntegrationCheck(config, integration, checks);
    config[integration].verify_status = check?.state === "ready" ? "verified" : "unverified";
  }
  return config;
}
