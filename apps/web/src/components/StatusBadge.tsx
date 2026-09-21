import type { RequestStatus } from "../types";

const TONE: Record<string, string> = {
  RECEIVED: "info",
  CLASSIFYING: "live",
  REJECTED: "bad",
  APPROVED: "ok",
  CHECKING_LIBRARY: "live",
  ALREADY_AVAILABLE: "ok",
  SEARCHING: "warn",
  QUEUED: "info",
  DOWNLOADING: "live",
  DOWNLOAD_COMPLETE: "ok",
  VALIDATING: "live",
  IMPORTING: "live",
  INDEXING: "live",
  READY: "ok",
  FAILED: "bad",
  CANCELLED: "warn",
  queued: "info",
  running: "live",
  succeeded: "ok",
  failed: "bad",
  cancelled: "warn",
  verified: "ok",
  unverified: "warn",
  needs_server_inspection: "warn",
};

export function StatusBadge({ value }: { value: string }) {
  const tone = TONE[value] ?? "info";
  return <span className={`badge ${tone}`}>{value}</span>;
}

export function statusLabel(status: RequestStatus): string {
  return status.replaceAll("_", " ");
}
