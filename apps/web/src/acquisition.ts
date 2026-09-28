import type { FieldSources } from "./types";

/** Live `state` values from GET /api/v1/acquisition/status and POST /api/v1/acquisition/test-connection. */
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

export const VERSION_PREFERENCE_OPTIONS = [
  { value: "balanced", label: "Balanced — remix, club, and extended first" },
  { value: "radio_edit", label: "Radio edit" },
  { value: "original", label: "Original / album version" },
  { value: "extended", label: "Extended / club mix" },
  { value: "remix", label: "Remix" },
] as const;

export const FORMAT_PREFERENCE_OPTIONS = [
  { value: "auto", label: "Auto — no format bonus" },
  { value: "prefer_mp3", label: "Prefer MP3" },
  { value: "prefer_flac", label: "Prefer FLAC" },
  { value: "mp3_only", label: "MP3 only" },
  { value: "flac_only", label: "FLAC only" },
] as const;

export type VersionPreference = (typeof VERSION_PREFERENCE_OPTIONS)[number]["value"];
export type FormatPreference = (typeof FORMAT_PREFERENCE_OPTIONS)[number]["value"];

/** Selector policy edited with acquisition settings. Sizes are MiB (1 MiB = 1,048,576 bytes). */
export type AcquisitionSelectionSettings = {
  preferred_max_file_size_mb: number;
  max_file_size_mb: number;
  preferred_max_duration_seconds: number;
  /** Null disables the hard duration cap. */
  max_duration_seconds: number | null;
  version_preference: VersionPreference;
  format_preference: FormatPreference;
};

/** GET/PUT /api/v1/acquisition/settings. The API key is never part of this object. */
export type AcquisitionSettings = {
  enabled: boolean;
  provider: string;
  base_url: string;
  verify_status: string;
  paths: { downloads: string; library: string };
  selection?: AcquisitionSelectionSettings;
  sources?: FieldSources;
  secrets_present: { slskd_api_key: boolean };
};

/** Body of GET /acquisition/status and POST /acquisition/test-connection. */
export type AcquisitionConnectionReport = {
  ok: boolean;
  state: string;
  probed: boolean;
  detail: string;
  settings: AcquisitionSettings;
};

export type AcquisitionDraft = {
  enabled: boolean;
  provider: string;
  base_url: string;
  api_key: string;
  downloads: string;
  library: string;
};

export function acquisitionStatusLabel(state: string): string {
  switch (state) {
    case "disabled":
      return "Acquisition disabled";
    case "not_configured":
      return "Not configured";
    case "unreachable":
      return "Unreachable";
    case "auth_failed":
      return "Auth failed";
    case "reachable":
      return "Reachable";
    case "soulseek_not_connected":
      return "Soulseek not connected";
    case "soulseek_not_logged_in":
      return "Soulseek not logged in";
    case "ready":
      return "Ready";
    default:
      return "Not configured";
  }
}

export function providerOptions(current: string, supported: string[] | undefined): string[] {
  const list = supported && supported.length > 0 ? supported : ["slskd"];
  return list.includes(current) ? list : [current, ...list];
}
