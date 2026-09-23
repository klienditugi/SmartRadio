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

export type AcquisitionSettings = {
  enabled: boolean;
  provider: string;
  base_url: string;
  downloads: string;
  library: string;
  api_key_configured: boolean;
  verify_status: string;
  supported_providers?: string[];
};

export type AcquisitionStatus = {
  state: string;
  verify_status: string;
  detail: string;
  checked_at: string;
  api_key_configured: boolean;
  worker_reload_required?: boolean;
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
