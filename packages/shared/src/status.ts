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
 * `verified` is not a state here. Only test-connection persists `verify_status: verified`.
 */
export const INTEGRATION_CONNECTION_STATES = [
  "not_configured",
  "configured_unverified",
  "unreachable",
  "auth_failed",
  "model_missing",
  "unhealthy",
  "ready",
] as const;
export type IntegrationConnectionState = (typeof INTEGRATION_CONNECTION_STATES)[number];

export const USER_ROLES = ["admin", "operator", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];
