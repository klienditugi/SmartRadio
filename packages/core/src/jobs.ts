import type { JobType, RequestStatus } from "@subwave-ai/shared";

/** Map a request status to the worker job that should run next (API only enqueues). */
export function jobTypeForStatus(status: RequestStatus): JobType | null {
  switch (status) {
    case "RECEIVED":
      return "classify";
    case "APPROVED":
      return "check_library";
    case "ALREADY_AVAILABLE":
      return "queue_radio";
    case "SEARCHING":
      return "search_acquisition";
    case "QUEUED":
      return "download";
    case "DOWNLOAD_COMPLETE":
      return "validate_file";
    case "VALIDATING":
      return "import_library";
    case "IMPORTING":
      // Leftover vs A3: happy path does not require Navidrome startScan.
      return "index_library";
    default:
      return null;
  }
}

export function restartStatusForJob(type: JobType): RequestStatus | null {
  switch (type) {
    case "classify":
      return "RECEIVED";
    case "check_library":
      return "APPROVED";
    case "search_acquisition":
      return "SEARCHING";
    case "download":
      return "QUEUED";
    case "validate_file":
      return "DOWNLOAD_COMPLETE";
    case "import_library":
      return "VALIDATING";
    case "index_library":
      return "IMPORTING";
    case "queue_radio":
      return "ALREADY_AVAILABLE";
    case "refresh_playlist":
      return null;
    default:
      return null;
  }
}
