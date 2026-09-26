/**
 * Correlate a selected search hit with GET /api/v0/transfers/downloads rows.
 *
 * Match order:
 * 1. `target.id` when a row has that id. This is a transfer id observed from the
 *    enqueue response or the transfers list, never a search response/file id.
 * 2. Exact username, then the exact original filename (backslashes included) and
 *    equal size. If that filename is present but the size is missing or different,
 *    there is no match.
 * 3. Otherwise a case-insensitive basename match, and only when exactly one of
 *    that user's rows matches the basename AND the size. Rows without a size
 *    do not match.
 */

export type TransferMatchTarget = {
  username: string;
  filename: string;
  size: number;
  /**
   * Transfer id from the enqueue response or a transfers row.
   * Search responses have no id; do not pass `responseId` / `fileId` here.
   */
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
  const parts = filename.split(/[/\\]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? filename;
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
    // `length` is duration on slskd search files and is not a byte size here.
    size: num(rec.size) ?? num(rec.bytes),
    bytes_transferred: num(rec.bytesTransferred) ?? num(rec.bytesDownloaded) ?? num(rec.transferred),
    id: idStr(rec.id) ?? idStr(rec.Id) ?? idStr(rec.transferId),
    raw_keys: Object.keys(rec),
  };
}

/**
 * Transfer id on an enqueue body, when exactly one object has this filename
 * (and size, if the object has a size) plus an id. `{ ok, status }` has neither.
 */
export function observedTransferId(
  result: unknown,
  target: { filename: string; size: number },
): string | undefined {
  const objects: Record<string, unknown>[] = [];
  collectObjects(result, objects);
  const ids = new Set<string>();
  for (const rec of objects) {
    const id = idStr(rec.id) ?? idStr(rec.Id) ?? idStr(rec.transferId);
    if (!id) continue;
    const filename = str(rec.filename) ?? str(rec.fileName) ?? str(rec.name);
    if (filename !== target.filename) continue;
    const size = num(rec.size) ?? num(rec.bytes);
    if (size !== undefined && size !== target.size) continue;
    ids.add(id);
  }
  if (ids.size !== 1) return undefined;
  return [...ids][0];
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

  const userRows = rows.filter((row) => row.user === target.username && row.filename);
  const exactName = userRows.filter((row) => row.filename === target.filename);
  const exactSized = exactName.filter((row) => row.size === target.size);
  if (exactSized.length > 0) return exactSized[0] ?? null;
  // The original path was seen, but no row confirms the size. Do not fall through
  // to a different file that only shares a basename.
  if (exactName.length > 0) return null;

  const targetBase = basenamePath(target.filename).toLowerCase();
  const byBaseAndSize = userRows.filter(
    (row) => row.filename !== undefined && basenamePath(row.filename).toLowerCase() === targetBase && row.size === target.size,
  );
  if (byBaseAndSize.length === 1) return byBaseAndSize[0] ?? null;
  return null;
}
