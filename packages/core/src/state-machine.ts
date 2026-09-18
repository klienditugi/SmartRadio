import { isTerminalStatus, type RequestStatus } from "@subwave-ai/shared";

/**
 * Allowed transitions. FAILED and CANCELLED are reachable from any
 * non-terminal status. Domain code is the only writer; persist via request_events.
 */
const GRAPH: Record<RequestStatus, readonly RequestStatus[]> = {
  RECEIVED: ["CLASSIFYING", "FAILED", "CANCELLED"],
  CLASSIFYING: ["REJECTED", "APPROVED", "RECEIVED", "FAILED", "CANCELLED"],
  // REJECTED stays cancel-terminal (TERMINAL_STATUSES) but operators may reclassify
  // (→ RECEIVED) or override station policy (→ APPROVED). Bot2 review: additive.
  REJECTED: ["RECEIVED", "APPROVED"],
  APPROVED: ["CHECKING_LIBRARY", "REJECTED", "FAILED", "CANCELLED"],
  CHECKING_LIBRARY: ["ALREADY_AVAILABLE", "SEARCHING", "FAILED", "CANCELLED"],
  ALREADY_AVAILABLE: ["QUEUED", "READY", "FAILED", "CANCELLED"],
  SEARCHING: ["QUEUED", "FAILED", "CANCELLED"],
  QUEUED: ["DOWNLOADING", "READY", "FAILED", "CANCELLED"],
  DOWNLOADING: ["DOWNLOAD_COMPLETE", "FAILED", "CANCELLED"],
  DOWNLOAD_COMPLETE: ["VALIDATING", "FAILED", "CANCELLED"],
  VALIDATING: ["IMPORTING", "FAILED", "CANCELLED"],
  IMPORTING: ["INDEXING", "FAILED", "CANCELLED"],
  INDEXING: ["READY", "FAILED", "CANCELLED"],
  READY: [],
  FAILED: [
    "RECEIVED",
    "APPROVED",
    "ALREADY_AVAILABLE",
    "SEARCHING",
    "QUEUED",
    "DOWNLOAD_COMPLETE",
    "VALIDATING",
    "IMPORTING",
  ],
  CANCELLED: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: RequestStatus,
    readonly to: RequestStatus,
  ) {
    super(`illegal request transition ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function allowedTransitions(from: RequestStatus): readonly RequestStatus[] {
  return GRAPH[from];
}

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return GRAPH[from].includes(to);
}

export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

export type RequestEventInput = {
  requestId: string;
  from: RequestStatus;
  to: RequestStatus;
  actor: string;
  payload?: unknown;
};

export function buildTransition(from: RequestStatus, to: RequestStatus): { from: RequestStatus; to: RequestStatus } {
  assertTransition(from, to);
  return { from, to };
}

export function assertCancellable(status: RequestStatus): void {
  if (isTerminalStatus(status)) {
    throw new Error(`cannot cancel request in terminal status ${status}`);
  }
}

export { GRAPH as REQUEST_TRANSITION_GRAPH };
