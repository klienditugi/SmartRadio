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

export type PublicUser = { id: string; username: string; role: string };

export type RequestRow = {
  id: string;
  user_id: string | null;
  raw_query: string;
  artist: string | null;
  title: string | null;
  genre: string | null;
  status: RequestStatus;
  classification_json: string | null;
  policy_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export type JobRow = {
  id: string;
  type: string;
  request_id: string | null;
  status: string;
  payload_json: string | null;
  result_json: string | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  created_at: number;
  updated_at: number;
};

export type RequestEventRow = {
  id: string;
  request_id: string;
  from_status: string;
  to_status: string;
  actor: string;
  payload_json: string | null;
  created_at: number;
};

export type AcquisitionRow = {
  id: string;
  request_id: string;
  remote_user: string | null;
  filename: string | null;
  status: string;
  progress: number | null;
  created_at: number;
  updated_at: number;
};

export type ProviderRow = {
  id: string;
  kind: string;
  name: string;
  verify_status: string;
  enabled: number;
  last_health_json: string | null;
  last_health_at: number | null;
  config_json: string;
};

export type DiskSnapshot = {
  path: string;
  role: string;
  ok: boolean;
  total_bytes?: number;
  free_bytes?: number;
  used_bytes?: number;
  used_ratio?: number;
  error?: string;
};

export type SetupStatus = {
  configured: boolean;
  setup_complete: boolean;
  missing: string[];
  ollama: string;
  secrets_present: Record<string, boolean>;
};
