/**
 * Best-effort extraction of slskd transfer progress.
 *
 * Verified: GET /api/v0/transfers/downloads exists. The JSON document shape of
 * each transfer is NEEDS_SERVER_INSPECTION — we only read commonly-named
 * numeric fields when present and never invent endpoints.
 */

export type TransferProgress = {
  user?: string;
  filename?: string;
  progress?: number;
  status?: string;
  bytes_transferred?: number;
  size?: number;
  raw_keys: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function progressFrom(record: Record<string, unknown>): number | undefined {
  const direct = num(record.percentComplete) ?? num(record.percent) ?? num(record.progress) ?? num(record.PercentageComplete);
  if (direct !== undefined) {
    return direct > 1 && direct <= 100 ? direct / 100 : direct;
  }
  const transferred = num(record.bytesTransferred) ?? num(record.bytesDownloaded) ?? num(record.transferred);
  const size = num(record.size) ?? num(record.bytes) ?? num(record.length);
  if (transferred !== undefined && size && size > 0) return Math.min(1, transferred / size);
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

export function extractTransferProgress(payload: unknown): TransferProgress[] {
  const objects: Record<string, unknown>[] = [];
  collectObjects(payload, objects);
  const out: TransferProgress[] = [];
  for (const rec of objects) {
    const filename = str(rec.filename) ?? str(rec.fileName) ?? str(rec.name);
    const user = str(rec.username) ?? str(rec.user) ?? str(rec.usernameRequested);
    const progress = progressFrom(rec);
    const status = str(rec.state) ?? str(rec.status);
    const bytes = num(rec.bytesTransferred) ?? num(rec.bytesDownloaded) ?? num(rec.transferred);
    const size = num(rec.size) ?? num(rec.bytes) ?? num(rec.length);
    if (filename === undefined && user === undefined && progress === undefined && status === undefined) continue;
    out.push({
      user,
      filename,
      progress,
      status,
      bytes_transferred: bytes,
      size,
      raw_keys: Object.keys(rec),
    });
  }
  return out;
}
