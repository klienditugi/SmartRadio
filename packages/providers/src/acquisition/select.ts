/**
 * Isolated selection of one usable slskd search hit.
 * Deterministic: same payload and options always return the same file.
 *
 * Exclusions (dropped before ranking):
 * - missing username, filename, or size <= 0 (`length` is seconds, never bytes)
 * - `lockedFiles` (never read) and any file with `isLocked: true`
 * - extension outside `allowedExtensions` when that list is set
 *   (an empty `extension` falls back to the filename)
 * - size greater than `maxFileSizeMb` × 1024 × 1024
 *   (option omitted → config default 200; `null` → no cap)
 * - `length` greater than `maxDurationSeconds` when that limit is set and the
 *   file reports `length` (omitted or null → no duration limit)
 * - `sampleRate` greater than `maxSampleRate` (omit → 48000 Hz; `null` → no cap)
 * - `bitDepth` greater than `maxBitDepth` (omit → 24; `null` → no cap)
 *   Files that do not report `sampleRate` or `bitDepth` stay eligible.
 *
 * Sort order (first difference wins):
 * 1. Extension rank: .flac, .wav, .m4a, .mp3, .ogg, then any other allowed extension.
 * 2. Version: clean files before penalized ones. Penalized when the basename or
 *    any parent folder matches a configured term (word boundary, case-insensitive).
 *    A term is not a penalty when the request artist/title contains that same term.
 * 3. Peer availability: `hasFreeUploadSlot` true, then false, then missing;
 *    then lower `queueLength` (missing last); then higher `uploadSpeed` (missing last).
 * 4. Quality, among files already inside the caps: higher bitDepth, then
 *    sampleRate, then bitRate. Missing bitDepth/sampleRate are neutral (they do
 *    not win or lose that key). A value above its cap is not better than the cap
 *    (those files are excluded before this step). Missing bitRate sorts last.
 * 5. Size closer to the median size of the remaining same-extension candidates
 *    (a typical file before an outlier).
 * 6. `username`, then the full `filename` (`localeCompare`). Equal keys keep payload order.
 *
 * `responseId` / `fileId` are copied when present. slskd search responses and
 * files have no id. Those fields are not rank keys and are not transfer ids.
 */

import {
  DEFAULT_MAX_BIT_DEPTH,
  DEFAULT_MAX_FILE_SIZE_MB,
  DEFAULT_MAX_SAMPLE_RATE,
  DEFAULT_VERSION_PENALTY_TERMS,
} from "@subwave-ai/shared";

export type SelectedSearchFile = {
  username: string;
  filename: string;
  size: number;
  /** Copied when the payload has one. Not used for ranking or transfer correlation. */
  responseId?: string;
  /** Copied when the payload has one. Not a transfer id. */
  fileId?: string;
  extension?: string;
  bitRate?: number;
};

/** Artist/title text used to waive version penalties. */
export type SelectSearchQuery = {
  artist?: string;
  title?: string;
  /** Extra request text, treated like artist/title for the version-term exception. */
  text?: string;
};

export type SelectSearchOptions = {
  /** Extensions with leading dots, e.g. `.flac`. Empty = any non-empty filename. */
  allowedExtensions?: readonly string[];
  /**
   * Mebibytes (1024×1024). Omit to use the config default (200).
   * `null` disables the cap.
   */
  maxFileSizeMb?: number | null;
  /** Seconds. Omit or null: no duration limit. Uses slskd `length` when present. */
  maxDurationSeconds?: number | null;
  /**
   * Hz. Omit for the broadcast-friendly default (48000). `null` disables the cap.
   * A reported `sampleRate` above this is excluded. A missing `sampleRate` stays eligible.
   */
  maxSampleRate?: number | null;
  /**
   * Omit for the broadcast-friendly default (24). `null` disables the cap.
   * A reported `bitDepth` above this is excluded. A missing `bitDepth` stays eligible.
   */
  maxBitDepth?: number | null;
  /** Word-boundary terms. Omit to use the config default list. Empty array: no penalty. */
  versionPenaltyTerms?: readonly string[];
  /** Request artist/title. `context` is the same option. */
  query?: SelectSearchQuery;
  context?: SelectSearchQuery;
};

/** Preference for deterministic ranking (higher = better). Unknown extensions rank last. */
const EXT_RANK: Record<string, number> = {
  ".flac": 50,
  ".wav": 40,
  ".m4a": 30,
  ".mp3": 20,
  ".ogg": 10,
};

type Candidate = SelectedSearchFile & {
  bitDepth?: number;
  sampleRate?: number;
  lengthSeconds?: number;
  hasFreeUploadSlot?: boolean;
  queueLength?: number;
  uploadSpeed?: number;
  penalized: boolean;
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

/** Empty `extension` falls back to the filename. A missing dot yields undefined. */
function normalizeExtension(raw: unknown, filename: string): string | undefined {
  const fromField = typeof raw === "string" ? raw.trim() : "";
  const source = fromField || extensionOf(filename);
  if (!source) return undefined;
  return source.startsWith(".") ? source.toLowerCase() : `.${source.toLowerCase()}`;
}

function locked(file: Record<string, unknown>): boolean {
  return file.isLocked === true || file.IsLocked === true;
}

function slotFlag(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

function collectCandidates(payload: unknown): Candidate[] {
  const out: Candidate[] = [];
  for (const raw of responsesFrom(payload)) {
    const response = asRecord(raw);
    if (!response) continue;
    const username = str(response.username) ?? str(response.user);
    if (!username) continue;
    const responseId = idStr(response.id) ?? idStr(response.responseId);
    const hasFreeUploadSlot = slotFlag(response.hasFreeUploadSlot ?? response.HasFreeUploadSlot);
    const queueLength = num(response.queueLength ?? response.QueueLength);
    const uploadSpeed = num(response.uploadSpeed ?? response.UploadSpeed);
    // `lockedFiles` is intentionally ignored.
    for (const rawFile of filesFrom(response)) {
      const file = asRecord(rawFile);
      if (!file || locked(file)) continue;
      const filename = str(file.filename) ?? str(file.fileName) ?? str(file.name);
      // `length` is duration in seconds on slskd 0.26, not a byte size.
      const size = num(file.size) ?? num(file.bytes) ?? num(file.Size);
      if (!filename || size === undefined || size <= 0) continue;
      const extension = normalizeExtension(file.extension ?? file.Extension, filename);
      const fileId = idStr(file.id) ?? idStr(file.fileId);
      const bitRate = num(file.bitRate) ?? num(file.bitrate) ?? num(file.BitRate);
      const bitDepth = num(file.bitDepth) ?? num(file.BitDepth);
      const sampleRate = num(file.sampleRate) ?? num(file.SampleRate);
      const lengthSeconds = num(file.length);
      out.push({
        username,
        filename,
        size,
        ...(responseId ? { responseId } : {}),
        ...(fileId ? { fileId } : {}),
        ...(extension ? { extension } : {}),
        ...(bitRate !== undefined ? { bitRate } : {}),
        ...(bitDepth !== undefined ? { bitDepth } : {}),
        ...(sampleRate !== undefined ? { sampleRate } : {}),
        ...(lengthSeconds !== undefined ? { lengthSeconds } : {}),
        ...(hasFreeUploadSlot !== undefined ? { hasFreeUploadSlot } : {}),
        ...(queueLength !== undefined ? { queueLength } : {}),
        ...(uploadSpeed !== undefined ? { uploadSpeed } : {}),
        penalized: false,
      });
    }
  }
  return out;
}

function allowed(candidate: Candidate, allowedExtensions?: readonly string[]): boolean {
  if (!allowedExtensions || allowedExtensions.length === 0) return true;
  const ext = (candidate.extension ?? extensionOf(candidate.filename)).toLowerCase();
  return allowedExtensions.some((item) => item.toLowerCase() === ext);
}

function maxBytes(maxFileSizeMb: number | null | undefined): number | null {
  if (maxFileSizeMb === null) return null;
  const mb = maxFileSizeMb === undefined ? DEFAULT_MAX_FILE_SIZE_MB : maxFileSizeMb;
  if (!Number.isFinite(mb) || mb <= 0) return null;
  return mb * 1024 * 1024;
}

function withinDuration(lengthSeconds: number | undefined, maxDurationSeconds: number | null | undefined): boolean {
  if (maxDurationSeconds === undefined || maxDurationSeconds === null) return true;
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) return true;
  if (lengthSeconds === undefined) return true;
  return lengthSeconds <= maxDurationSeconds;
}

/** `undefined` uses the default. `null` or a non-positive number disables the cap. */
function resolveCap(value: number | null | undefined, fallback: number): number | null {
  if (value === null) return null;
  const cap = value === undefined ? fallback : value;
  if (!Number.isFinite(cap) || cap <= 0) return null;
  return cap;
}

/** Missing measurements stay eligible. A reported value above the cap does not. */
function withinBroadcast(row: Candidate, maxSampleRate: number | null, maxBitDepth: number | null): boolean {
  if (maxSampleRate !== null && row.sampleRate !== undefined && row.sampleRate > maxSampleRate) return false;
  if (maxBitDepth !== null && row.bitDepth !== undefined && row.bitDepth > maxBitDepth) return false;
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPattern(term: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
}

/** Basename plus every parent folder. Empty segments from leading slashes are dropped. */
function pathTargets(filename: string): string[] {
  const parts = filename.split(/[/\\]/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts : [filename];
}

function requestedText(opts: SelectSearchOptions): string {
  const query = { ...opts.context, ...opts.query };
  return [query.artist, query.title, query.text]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ");
}

function versionPenalized(filename: string, terms: readonly string[], requested: string): boolean {
  const targets = pathTargets(filename);
  for (const term of terms) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    const pattern = termPattern(trimmed);
    if (!targets.some((segment) => pattern.test(segment))) continue;
    if (requested && pattern.test(requested)) continue;
    return true;
  }
  return false;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const right = sorted[mid];
  if (right === undefined) return 0;
  if (sorted.length % 2 === 1) return right;
  const left = sorted[mid - 1];
  if (left === undefined) return right;
  return (left + right) / 2;
}

function mediansByExtension(candidates: Candidate[]): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const row of candidates) {
    const ext = (row.extension ?? "").toLowerCase();
    const list = groups.get(ext);
    if (list) list.push(row.size);
    else groups.set(ext, [row.size]);
  }
  const medians = new Map<string, number>();
  for (const [ext, sizes] of groups) medians.set(ext, median(sizes));
  return medians;
}

function cmpHigher(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (a === b) return 0;
  return b - a;
}

/**
 * Higher wins when both sides report a value. A missing value is neutral.
 * Values above `cap` compare as the cap, so they are not better than the cap.
 */
function cmpWithinCap(a: number | undefined, b: number | undefined, cap: number | null): number {
  const left = a === undefined ? undefined : cap === null ? a : Math.min(a, cap);
  const right = b === undefined ? undefined : cap === null ? b : Math.min(b, cap);
  if (left === undefined || right === undefined) return 0;
  if (left === right) return 0;
  return right - left;
}

function compareCandidates(
  a: Candidate,
  b: Candidate,
  medians: Map<string, number>,
  maxSampleRate: number | null,
  maxBitDepth: number | null,
): number {
  const aExt = (a.extension ?? extensionOf(a.filename)).toLowerCase();
  const bExt = (b.extension ?? extensionOf(b.filename)).toLowerCase();
  const extDiff = (EXT_RANK[bExt] ?? 0) - (EXT_RANK[aExt] ?? 0);
  if (extDiff !== 0) return extDiff;

  const penaltyDiff = Number(a.penalized) - Number(b.penalized);
  if (penaltyDiff !== 0) return penaltyDiff;

  const slotRank = (value: boolean | undefined) => (value === true ? 0 : value === false ? 1 : 2);
  const slotDiff = slotRank(a.hasFreeUploadSlot) - slotRank(b.hasFreeUploadSlot);
  if (slotDiff !== 0) return slotDiff;

  const queueA = a.queueLength ?? Number.POSITIVE_INFINITY;
  const queueB = b.queueLength ?? Number.POSITIVE_INFINITY;
  if (queueA !== queueB) return queueA - queueB;

  const speedA = a.uploadSpeed ?? Number.NEGATIVE_INFINITY;
  const speedB = b.uploadSpeed ?? Number.NEGATIVE_INFINITY;
  if (speedA !== speedB) return speedB - speedA;

  const depthDiff = cmpWithinCap(a.bitDepth, b.bitDepth, maxBitDepth);
  if (depthDiff !== 0) return depthDiff;
  const rateDiff = cmpWithinCap(a.sampleRate, b.sampleRate, maxSampleRate);
  if (rateDiff !== 0) return rateDiff;
  const bitDiff = cmpHigher(a.bitRate, b.bitRate);
  if (bitDiff !== 0) return bitDiff;

  const medianA = medians.get(aExt) ?? a.size;
  const medianB = medians.get(bExt) ?? b.size;
  const distanceA = Math.abs(a.size - medianA);
  const distanceB = Math.abs(b.size - medianB);
  if (distanceA !== distanceB) return distanceA - distanceB;

  const userCmp = a.username.localeCompare(b.username);
  if (userCmp !== 0) return userCmp;
  return a.filename.localeCompare(b.filename);
}

function toSelected(row: Candidate): SelectedSearchFile {
  return {
    username: row.username,
    filename: row.filename,
    size: row.size,
    ...(row.responseId ? { responseId: row.responseId } : {}),
    ...(row.fileId ? { fileId: row.fileId } : {}),
    ...(row.extension ? { extension: row.extension } : {}),
    ...(row.bitRate !== undefined ? { bitRate: row.bitRate } : {}),
  };
}

/**
 * Pick one usable search response file. Deterministic for the same payload.
 * Returns null when nothing usable is present.
 * Ranking order is documented on this module.
 */
export function selectSearchResult(payload: unknown, opts: SelectSearchOptions = {}): SelectedSearchFile | null {
  const cap = maxBytes(opts.maxFileSizeMb);
  const maxSampleRate = resolveCap(opts.maxSampleRate, DEFAULT_MAX_SAMPLE_RATE);
  const maxBitDepth = resolveCap(opts.maxBitDepth, DEFAULT_MAX_BIT_DEPTH);
  const terms = opts.versionPenaltyTerms ?? DEFAULT_VERSION_PENALTY_TERMS;
  const requested = requestedText(opts);
  const candidates = collectCandidates(payload).filter((row) => {
    if (!allowed(row, opts.allowedExtensions)) return false;
    if (cap !== null && row.size > cap) return false;
    if (!withinDuration(row.lengthSeconds, opts.maxDurationSeconds)) return false;
    if (!withinBroadcast(row, maxSampleRate, maxBitDepth)) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  for (const row of candidates) {
    row.penalized = versionPenalized(row.filename, terms, requested);
  }
  const medians = mediansByExtension(candidates);
  candidates.sort((a, b) => compareCandidates(a, b, medians, maxSampleRate, maxBitDepth));
  const best = candidates[0];
  return best ? toSelected(best) : null;
}

export function isSearchComplete(payload: unknown): boolean {
  const rec = asRecord(payload);
  if (!rec) return false;
  if (rec.isComplete === true) return true;
  const state = str(rec.state) ?? str(rec.State);
  if (!state) return false;
  return /\bcompleted\b/i.test(state);
}
