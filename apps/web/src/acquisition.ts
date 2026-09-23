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

/** GET/PUT /api/v1/acquisition/settings. The API key is never part of this object. */
export type AcquisitionSettings = {
  enabled: boolean;
  provider: string;
  base_url: string;
  verify_status: string;
  paths: { downloads: string; library: string };
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
