export const REQUEST_STATUSES = [
  "RECEIVED",
  "CLASSIFYING",
  "REJECTED",
  "APPROVED",
  "CHECKING_LIBRARY",
  "ALREADY_AVAILABLE",
  "SEARCHING",
  "QUEUED",
  "DOWNLOADING",
  "DOWNLOAD_COMPLETE",
  "VALIDATING",
  "IMPORTING",
  "INDEXING",
  "READY",
  "FAILED",
  "CANCELLED",
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const TERMINAL_STATUSES: readonly RequestStatus[] = [
  "REJECTED",
  "READY",
  "FAILED",
  "CANCELLED",
];

export function isRequestStatus(value: string): value is RequestStatus {
  return (REQUEST_STATUSES as readonly string[]).includes(value);
}

export function isTerminalStatus(status: RequestStatus): boolean {
  return (TERMINAL_STATUSES as readonly RequestStatus[]).includes(status);
}

export const JOB_TYPES = [
  "classify",
  "check_library",
  "search_acquisition",
  "download",
  "validate_file",
  "import_library",
  "index_library",
  "queue_radio",
  "health_probe",
  "refresh_playlist",
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const PROVIDER_KINDS = ["llm", "library", "radio", "acquisition"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const VERIFY_STATUSES = ["verified", "unverified", "needs_server_inspection"] as const;
export type VerifyStatus = (typeof VERIFY_STATUSES)[number];

/** Live or config-derived acquisition connection states. Never inferred from verify_status alone while probing. */
export const ACQUISITION_CONNECTION_STATES = [
  "disabled",
  "not_configured",
  "configured_unverified",
  "unreachable",
  "auth_failed",
  "reachable",
  "soulseek_not_connected",
  "soulseek_not_logged_in",
  "ready",
] as const;
export type AcquisitionConnectionState = (typeof ACQUISITION_CONNECTION_STATES)[number];

/**
 * Live or config-derived states for Ollama, Navidrome, and SUB/WAVE.
 * Precedence: `not_configured`, then `configured_unverified`, then probe states.
 * `not_configured` means settings are missing and no network call was made.
 * `configured_unverified` means settings are filled and test-connection has not verified them.
 * `unreachable` means settings were present and a probe could not connect.
 * `reachable` means a health probe got a response. `ready` is a successful test-connection.
 */
export const INTEGRATION_CONNECTION_STATES = [
  "not_configured",
  "configured_unverified",
  "unreachable",
  "reachable",
  "auth_failed",
  "model_missing",
  "unhealthy",
  "ready",
] as const;
export type IntegrationConnectionState = (typeof INTEGRATION_CONNECTION_STATES)[number];

export type IntegrationReport = {
  state: IntegrationConnectionState | null;
  probed: boolean;
  detail: string;
};

export const NAVIDROME_NOT_CONFIGURED = "navidrome is not configured";
export const SUBWAVE_RADIO_NOT_CONFIGURED = "subwave radio is not configured";

/** No default host or model. A blank model is still not_configured, never a hard-coded name. */
export function ollamaNotConfiguredDetail(input: { baseUrl: string; model: string }): string {
  if (!input.model.trim()) {
    return "ollama is not configured: LLM model is not configured (refusing to hard-code a model name)";
  }
  if (!input.baseUrl.trim()) return "ollama is not configured";
  return "ollama is not configured";
}

type StoredIntegrationHealth = {
  ok?: boolean;
  state?: string;
  detail?: string;
};

function readStoredHealth(healthJson?: string | null): StoredIntegrationHealth | null {
  if (!healthJson) return null;
  try {
    const parsed = JSON.parse(healthJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as StoredIntegrationHealth;
  } catch {
    return null;
  }
}

/**
 * Config wins over a stale probe. Missing settings are always `not_configured`
 * and are not described as unreachable.
 */
export function describeIntegration(
  configured: boolean,
  missingDetail: string,
  healthJson?: string | null,
): IntegrationReport {
  if (!configured) {
    return { state: "not_configured", probed: false, detail: missingDetail };
  }
  const health = readStoredHealth(healthJson);
  if (health?.state === "unreachable") {
    return { state: "unreachable", probed: true, detail: health.detail ?? "unreachable" };
  }
  if (health?.state === "reachable" || health?.ok === true) {
    return { state: "reachable", probed: true, detail: health.detail ?? "reachable" };
  }
  if (health && health.ok === false && health.state !== "not_configured") {
    return { state: null, probed: true, detail: health.detail ?? "health check failed" };
  }
  return { state: null, probed: false, detail: "settings present; health probe has not run" };
}

export const USER_ROLES = ["admin", "operator", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];
