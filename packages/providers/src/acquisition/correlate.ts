/**
 * Correlate a selected search hit with GET /api/v0/transfers/downloads rows.
 * Uses strongest verified identifiers: transfer id, then username + filename + size.
 */

export type TransferMatchTarget = {
  username: string;
  filename: string;
  size: number;
  /** Transfer / file id when known from enqueue or search. */
  id?: string;
};

export type CorrelatedTransfer = {
  user?: string;
  filename?: string;
  progress?: number;
  status?: string;
  state: string;
  size?: number;
  bytes_transferred?: number;
  id?: string;
  raw_keys: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function idStr(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function collectObjects(value: unknown, into: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, into);
    return;
  }
  const rec = asRecord(value);
  if (!rec) return;
  into.push(rec);
  for (const nested of Object.values(rec)) {
    if (nested && typeof nested === "object") collectObjects(nested, into);
  }
}

function basenamePath(filename: string): string {
  const parts = filename.split(/[/\\]/);
  return parts[parts.length - 1] ?? filename;
}

function filenamesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return basenamePath(a).toLowerCase() === basenamePath(b).toLowerCase();
}

function stateTokens(state: string): string[] {
  return state
    .split(/[,|]/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/** Completed AND Succeeded, and not Errored. */
export function isTransferSucceeded(state: string | undefined): boolean {
  if (!state) return false;
  const tokens = stateTokens(state);
  return tokens.includes("completed") && tokens.includes("succeeded") && !tokens.includes("errored");
}

export function isTransferErrored(state: string | undefined): boolean {
  if (!state) return false;
  const tokens = stateTokens(state);
  return tokens.includes("errored") || (tokens.includes("completed") && tokens.includes("cancelled"));
}

export function isTransferInProgress(state: string | undefined): boolean {
  if (!state) return true;
  if (isTransferSucceeded(state) || isTransferErrored(state)) return false;
  return true;
}

function progressFrom(record: Record<string, unknown>): number | undefined {
  const direct =
    num(record.percentComplete) ?? num(record.percent) ?? num(record.progress) ?? num(record.PercentageComplete);
  if (direct !== undefined) {
    return direct > 1 && direct <= 100 ? direct / 100 : direct;
  }
  const transferred = num(record.bytesTransferred) ?? num(record.bytesDownloaded) ?? num(record.transferred);
  const size = num(record.size) ?? num(record.bytes) ?? num(record.length);
  if (transferred !== undefined && size && size > 0) return Math.min(1, transferred / size);
  return undefined;
}

function rowFrom(rec: Record<string, unknown>): CorrelatedTransfer | null {
  const filename = str(rec.filename) ?? str(rec.fileName) ?? str(rec.name);
  const user = str(rec.username) ?? str(rec.user) ?? str(rec.usernameRequested);
  const state = str(rec.state) ?? str(rec.status);
  if (filename === undefined && user === undefined && state === undefined) return null;
  if (!state) return null;
  return {
    user,
    filename,
    state,
    status: state,
    progress: progressFrom(rec),
    size: num(rec.size) ?? num(rec.bytes) ?? num(rec.length),
    bytes_transferred: num(rec.bytesTransferred) ?? num(rec.bytesDownloaded) ?? num(rec.transferred),
    id: idStr(rec.id) ?? idStr(rec.Id) ?? idStr(rec.transferId),
    raw_keys: Object.keys(rec),
  };
}

/**
 * Find the transfer that matches the selected enqueue target.
 * Rejects unrelated completed transfers.
 */
export function findCorrelatedTransfer(
  snapshot: unknown,
  target: TransferMatchTarget,
): CorrelatedTransfer | null {
  const objects: Record<string, unknown>[] = [];
  collectObjects(snapshot, objects);
  const rows = objects.map(rowFrom).filter((row): row is CorrelatedTransfer => row !== null);

  if (target.id) {
    const byId = rows.find((row) => row.id === target.id);
    if (byId) return byId;
  }

  const matches = rows.filter((row) => {
    if (!row.user || row.user !== target.username) return false;
    if (!row.filename || !filenamesMatch(row.filename, target.filename)) return false;
    return true;
  });

  const exact = matches.find((row) => row.size === target.size);
  if (exact) return exact;
  // Size may be absent on some transfer rows; username+filename is still strong.
  const withoutSize = matches.find((row) => row.size === undefined);
  return withoutSize ?? null;
}
