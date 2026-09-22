/**
 * Isolated selection of a usable slskd search hit.
 * Improves later (bitrate/size heuristics) without rewriting the provider.
 */

export type SelectedSearchFile = {
  username: string;
  filename: string;
  size: number;
  /** Peer response id when present (correlation). */
  responseId?: string;
  /** File id when present (correlation). */
  fileId?: string;
  extension?: string;
  bitRate?: number;
};

export type SelectSearchOptions = {
  /** Extensions with leading dots, e.g. `.flac`. Empty = any non-empty filename. */
  allowedExtensions?: readonly string[];
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

function extensionOf(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/** Preference for deterministic ranking (higher = better). Unknown extensions rank last. */
const EXT_RANK: Record<string, number> = {
  ".flac": 50,
  ".wav": 40,
  ".m4a": 30,
  ".mp3": 20,
  ".ogg": 10,
};

function responsesFrom(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const rec = asRecord(payload);
  if (!rec) return [];
  if (Array.isArray(rec.responses)) return rec.responses;
  return [];
}

function filesFrom(response: Record<string, unknown>): unknown[] {
  if (Array.isArray(response.files)) return response.files;
  if (Array.isArray(response.Files)) return response.Files;
  return [];
}

function collectCandidates(payload: unknown): SelectedSearchFile[] {
  const out: SelectedSearchFile[] = [];
  for (const raw of responsesFrom(payload)) {
    const response = asRecord(raw);
    if (!response) continue;
    const username = str(response.username) ?? str(response.user);
    if (!username) continue;
    const responseId = idStr(response.id) ?? idStr(response.responseId);
    for (const rawFile of filesFrom(response)) {
      const file = asRecord(rawFile);
      if (!file) continue;
      const filename = str(file.filename) ?? str(file.fileName) ?? str(file.name);
      const size = num(file.size) ?? num(file.length) ?? num(file.bytes);
      if (!filename || size === undefined || size <= 0) continue;
      const rawExt = str(file.extension) ?? extensionOf(filename);
      const extension = rawExt
        ? rawExt.startsWith(".")
          ? rawExt.toLowerCase()
          : `.${rawExt.toLowerCase()}`
        : undefined;
      out.push({
        username,
        filename,
        size,
        responseId,
        fileId: idStr(file.id) ?? idStr(file.fileId),
        extension,
        bitRate: num(file.bitRate) ?? num(file.bitrate) ?? num(file.BitRate),
      });
    }
  }
  return out;
}

function allowed(candidate: SelectedSearchFile, allowedExtensions?: readonly string[]): boolean {
  if (!allowedExtensions || allowedExtensions.length === 0) return true;
  const ext = (candidate.extension ?? extensionOf(candidate.filename)).toLowerCase();
  return allowedExtensions.some((item) => item.toLowerCase() === ext);
}

function compareCandidates(a: SelectedSearchFile, b: SelectedSearchFile): number {
  const aExt = (a.extension ?? extensionOf(a.filename)).toLowerCase();
  const bExt = (b.extension ?? extensionOf(b.filename)).toLowerCase();
  const rankDiff = (EXT_RANK[bExt] ?? 0) - (EXT_RANK[aExt] ?? 0);
  if (rankDiff !== 0) return rankDiff;
  if (b.size !== a.size) return b.size - a.size;
  const bitA = a.bitRate ?? 0;
  const bitB = b.bitRate ?? 0;
  if (bitB !== bitA) return bitB - bitA;
  const userCmp = a.username.localeCompare(b.username);
  if (userCmp !== 0) return userCmp;
  return a.filename.localeCompare(b.filename);
}

/**
 * Pick one usable search response file. Deterministic for the same payload.
 * Returns null when nothing usable is present.
 */
export function selectSearchResult(
  payload: unknown,
  opts: SelectSearchOptions = {},
): SelectedSearchFile | null {
  const candidates = collectCandidates(payload).filter((row) => allowed(row, opts.allowedExtensions));
  if (candidates.length === 0) return null;
  candidates.sort(compareCandidates);
  return candidates[0] ?? null;
}

export function isSearchComplete(payload: unknown): boolean {
  const rec = asRecord(payload);
  if (!rec) return false;
  if (rec.isComplete === true) return true;
  const state = str(rec.state) ?? str(rec.State);
  if (!state) return false;
  return /\bcompleted\b/i.test(state);
}
