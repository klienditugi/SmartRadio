import { createHmac } from "node:crypto";
import type { RuntimeConfig } from "./config.js";

export const INTEGRATION_NAMES = ["llm", "library", "radio", "acquisition"] as const;
export type IntegrationName = (typeof INTEGRATION_NAMES)[number];

/**
 * A test-connection row. `fingerprint` is HMAC-SHA256 over the config that was tested.
 * Callers must not put it in API responses, logs, doctor output, errors, or the UI.
 */
export type StoredIntegrationCheck = {
  integration: string;
  state: string;
  fingerprint: string;
  testedAt: number;
};

function canonical(fields: Record<string, string | undefined>): string {
  const keys = Object.keys(fields)
    .filter((key) => fields[key] !== undefined)
    .sort();
  return JSON.stringify(keys.map((key) => [key, fields[key] ?? ""]));
}

function hmacKey(config: RuntimeConfig): Buffer | null {
  const key = config.secrets.verificationHmacKey;
  if (!key || key.length !== 32) return null;
  return key;
}

/**
 * One HMAC-SHA256 over the URL, user, model, and the secret value.
 * Keyed with `secrets/verification_hmac_key` (32 bytes), not the session secret,
 * so rotating sessions does not invalidate verification. A missing or unusable
 * key returns null and must not match any stored row.
 */
export function integrationConfigFingerprint(config: RuntimeConfig, integration: IntegrationName): string | null {
  const key = hmacKey(config);
  if (!key) return null;
  const secret =
    integration === "library"
      ? (config.secrets.navidromePassword ?? "")
      : integration === "radio"
        ? (config.secrets.subwaveAdminPassword ?? "")
        : integration === "acquisition"
          ? (config.secrets.slskdApiKey ?? "")
          : "";
  const fields =
    integration === "llm"
      ? {
          integration,
          provider: config.llm.provider,
          base_url: config.llm.base_url.trim(),
          model: config.llm.model.trim(),
          secret,
        }
      : integration === "library"
        ? {
            integration,
            provider: config.library.provider,
            base_url: config.library.base_url.trim(),
            username: config.library.username.trim(),
            client_name: config.library.client_name,
            api_version: config.library.api_version,
            secret,
          }
        : integration === "radio"
          ? {
              integration,
              provider: config.radio.provider,
              base_url: config.radio.base_url.trim(),
              admin_user: config.radio.admin_user.trim(),
              secret,
            }
          : {
              integration,
              provider: config.acquisition.provider.trim(),
              base_url: config.acquisition.base_url.trim(),
              enabled: config.acquisition.enabled ? "true" : "false",
              secret,
            };
  return createHmac("sha256", key).update(canonical(fields), "utf8").digest("hex");
}

export function findMatchingIntegrationCheck(
  config: RuntimeConfig,
  integration: IntegrationName,
  checks: readonly StoredIntegrationCheck[],
): StoredIntegrationCheck | null {
  const fingerprint = integrationConfigFingerprint(config, integration);
  if (!fingerprint) return null;
  const check = checks.find((row) => row.integration === integration);
  if (!check || check.fingerprint !== fingerprint) return null;
  return check;
}

/** `verified` only when a stored result is `ready` for the current HMAC fingerprint. */
export function applyStoredVerification<T extends RuntimeConfig>(config: T, checks: readonly StoredIntegrationCheck[]): T {
  for (const integration of INTEGRATION_NAMES) {
    const check = findMatchingIntegrationCheck(config, integration, checks);
    config[integration].verify_status = check?.state === "ready" ? "verified" : "unverified";
  }
  return config;
}
