/**
 * Isolated selection of one usable slskd search hit.
 * Deterministic: same payload and options always return the same file.
 *
 * Exclusions (dropped before ranking, first match wins):
 * - missing username, filename, or size <= 0 (`length` is seconds, never bytes)
 * - `lockedFiles` (never read) and any file with `isLocked: true`
 * - junk: basename starting with `._`, or a `__MACOSX` path segment
 *   (case-insensitive, `\` and `/`)
 * - extension outside `allowedExtensions` when that list is set
 *   (an empty `extension` falls back to the filename)
 * - size smaller than `minFileSizeMb` × 1024 × 1024
 *   (option omitted → config default 1; `null` → no floor)
 * - size greater than `maxFileSizeMb` × 1024 × 1024
 *   (option omitted → config default 200; `null` → no cap)
 * - `length` greater than `maxDurationSeconds` when that limit is set and the
 *   file reports `length` (omitted or null → no duration limit)
 * - `sampleRate` greater than `maxSampleRate` (omit → 48000 Hz; `null` → no cap)
 * - `bitDepth` greater than `maxBitDepth` (omit → 24; `null` → no cap)
 *   Files that do not report `sampleRate` or `bitDepth` stay eligible.
 * - title mismatch, only when `query.title` or `context.title` is set.
 *   Calls that omit a title (the old signature) skip this filter.
 *   The worker always passes the request artist and title.
 *
 * One pass. If every candidate is removed, the result is no pick. This module
 * does not widen extensions, raise a cap, or read `lockedFiles` as a fallback.
 * A payload with no response rows is `no_responses`, not `no_suitable_result`.
 *
 * Sort order (first difference wins):
 * 1. Extension rank: .flac, .wav, .m4a, .mp3, .ogg, then any other allowed extension.
 * 2. Content tier, best first: a requested-version match (only when the request
 *    names a version term), then a clean file, then a version-penalized file
 *    (remix, live, edit, and the other penalty terms), then an instrument-part
 *    basename. A file that is both version-penalized and an instrument part is
 *    the instrument-part tier. Version words are not required title tokens.
 *    The instrument tier is not an exclusion. A request whose title tokens are
 *    in the basename (the request asks for that part) is not an instrument part.
 * 3. Artist tokens present in the path (positive tiebreak). Artist tokens are
 *    not required. Missing artist text does not change the order.
 * 4. Peer availability: `hasFreeUploadSlot` true, then false, then missing;
 *    then lower `queueLength` (missing last); then higher `uploadSpeed` (missing last).
 * 5. Quality, among files already inside the caps: higher bitDepth, then
 *    sampleRate, then bitRate. Missing bitDepth/sampleRate are neutral (they do
 *    not win or lose that key). A value above its cap is not better than the cap
 *    (those files are excluded before this step). Missing bitRate sorts last.
 * 6. Size closer to the median size of the remaining same-extension candidates
 *    (a typical file before an outlier).
 * 7. `username`, then the full `filename` (`localeCompare`). Equal keys keep payload order.
 *
 * `responseId` / `fileId` are copied when present. slskd search responses and
 * files have no id. Those fields are not rank keys and are not transfer ids.
 */

import {
  DEFAULT_INSTRUMENT_PART_BASENAMES,
  DEFAULT_MAX_BIT_DEPTH,
  DEFAULT_MAX_FILE_SIZE_MB,
  DEFAULT_MAX_SAMPLE_RATE,
  DEFAULT_MIN_FILE_SIZE_MB,
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
   * Mebibytes (1024×1024). Omit to use the config default (1).
   * `null` disables the floor.
   */
  minFileSizeMb?: number | null;
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
  /**
   * Basename tokens that rank below a full track when the basename does not
   * contain the title tokens. Omit for the config default. Empty array: no penalty.
   */
  instrumentPartBasenames?: readonly string[];
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
  /**
   * Lower is better. 0 requested-version match, 1 clean, 2 version-penalized,
   * 3 instrument-part. A penalized instrument part is 3. A requested-version
   * match stays 0.
   */
  versionRank: number;
  artistMatch: boolean;
  lockedFile: boolean;
};

/** Exclusive counts. Each removed candidate increments the first filter that rejects it. */
export type FilterRemovalCounts = {
  locked: number;
  junk: number;
  extensions: number;
  min_file_size: number;
  max_file_size: number;
  max_duration: number;
  max_sample_rate: number;
  max_bit_depth: number;
  title_mismatch: number;
};

export type SearchSelection =
  | { outcome: "selected"; file: SelectedSearchFile }
  | { outcome: "no_responses" }
  | { outcome: "no_usable_candidate" }
  | { outcome: "no_suitable_result"; removed: FilterRemovalCounts; reason: string };

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
    // `lockedFiles` is intentionally ignored. It is not a fallback pool.
    for (const rawFile of filesFrom(response)) {
      const file = asRecord(rawFile);
      if (!file) continue;
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
        versionRank: 0,
        artistMatch: false,
        lockedFile: locked(file),
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

function sizeBytes(mb: number | null | undefined, fallback: number): number | null {
  if (mb === null) return null;
  const value = mb === undefined ? fallback : mb;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value * 1024 * 1024;
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
  const query = requestFields(opts);
  const title = typeof query.title === "string" ? dropBracketedCredits(query.title) : "";
  return [query.artist, title, query.text]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ");
}

const TITLE_STOPWORDS = new Set(["a", "an", "the", "and", "of", "feat", "ft"]);

/** AppleDouble basename, or a `__MACOSX` path segment. Case-insensitive. */
function isJunkPath(filename: string): boolean {
  const parts = filename.split(/[/\\]/).filter((part) => part.length > 0);
  const base = parts[parts.length - 1] ?? filename;
  if (base.toLowerCase().startsWith("._")) return true;
  return parts.some((part) => part.toLowerCase() === "__macosx");
}

function dropBracketedCredits(title: string): string {
  return title.replace(/[\[({][^\]\)}]*\b(?:feat|ft)\.?\b[^\]\)}]*[\]\)}]/gi, " ");
}

function normalizeMatchText(value: string, dropCredits: boolean): string {
  const source = dropCredits ? dropBracketedCredits(value) : value;
  const folded = source.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const withoutApostrophes = folded.replace(/[''`´]/g, "");
  return withoutApostrophes.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function significantTokens(normalized: string): string[] {
  const tokens = normalized ? normalized.split(" ") : [];
  if (tokens.length === 0) return [];
  const withoutStops = tokens.filter((token) => !TITLE_STOPWORDS.has(token));
  const base = withoutStops.length > 0 ? withoutStops : tokens;
  if (base.some((token) => token.length > 1)) return base.filter((token) => token.length > 1);
  return base;
}

function stripVersionTerms(normalized: string, terms: readonly string[]): string {
  const phrases = terms
    .map((term) => normalizeMatchText(term, false))
    .filter((term) => term.length > 0)
    .sort((a, b) => b.length - a.length);
  let text = normalized;
  for (const phrase of phrases) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "gi"), " ");
  }
  return text.replace(/\s+/g, " ").trim();
}

function requestFields(opts: SelectSearchOptions): SelectSearchQuery {
  return { ...opts.context, ...opts.query };
}

/**
 * Title tokens the candidate must contain. Null means the filter is off:
 * no title was passed (old call signature), or nothing significant remains.
 * Version-penalty terms are removed first so "Remix" changes rank, not eligibility.
 */
function requiredTitleTokens(opts: SelectSearchOptions, terms: readonly string[]): string[] | null {
  const title = requestFields(opts).title;
  if (typeof title !== "string" || !title.trim()) return null;
  const tokens = significantTokens(stripVersionTerms(normalizeMatchText(title, true), terms));
  return tokens.length > 0 ? tokens : null;
}

function artistTokens(opts: SelectSearchOptions): string[] {
  const artist = requestFields(opts).artist;
  if (typeof artist !== "string" || !artist.trim()) return [];
  return significantTokens(normalizeMatchText(artist, false));
}

function candidateText(filename: string): string {
  return normalizeMatchText(pathTargets(filename).join(" "), false);
}

function textHasToken(haystack: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(haystack);
}

function hasEveryToken(filename: string, tokens: readonly string[]): boolean {
  const text = candidateText(filename);
  return tokens.every((token) => textHasToken(text, token));
}

function basenameStem(filename: string): string {
  const parts = filename.split(/[/\\]/).filter((part) => part.length > 0);
  const base = parts[parts.length - 1] ?? filename;
  return base.replace(/\.[^.]+$/, "");
}

/**
 * Penalty, not an exclusion. Applies when a whole basename token is on the list
 * and the basename itself does not contain the title tokens.
 */
function instrumentPartRank(filename: string, titleTokens: readonly string[] | null, terms: readonly string[]): number {
  const stem = basenameStem(filename);
  if (titleTokens && titleTokens.length > 0 && hasEveryToken(stem, titleTokens)) return 0;
  const tokens = normalizeMatchText(stem, false).split(" ").filter((token) => token.length > 0);
  const wanted = new Set(terms.map((term) => term.trim().toLowerCase()).filter((term) => term.length > 0));
  return tokens.some((token) => wanted.has(token)) ? 1 : 0;
}

type VersionClass = "requested" | "clean" | "penalized";

/**
 * Requested-version match, otherwise clean, otherwise a penalty term the
 * request did not ask for.
 */
function versionClass(filename: string, terms: readonly string[], requested: string): VersionClass {
  const targets = pathTargets(filename);
  const active = terms.map((term) => term.trim()).filter((term) => term.length > 0);
  const requestedTerms = requested ? active.filter((term) => termPattern(term).test(requested)) : [];
  const fileTerms = active.filter((term) => targets.some((segment) => termPattern(term).test(segment)));
  const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
  if (requestedTerms.length > 0 && fileTerms.some((term) => requestedTerms.some((asked) => same(asked, term)))) {
    return "requested";
  }
  const penalized = fileTerms.some((term) => !requestedTerms.some((asked) => same(asked, term)));
  return penalized ? "penalized" : "clean";
}

/**
 * One tier for the old version step and the instrument-part penalty.
 * Best first: requested version, clean, version-penalized, instrument part.
 * A file that is both version-penalized and an instrument part is the
 * instrument-part tier. A requested-version match stays in the top tier.
 */
function contentTier(
  filename: string,
  terms: readonly string[],
  requested: string,
  titleTokens: readonly string[] | null,
  instrumentTerms: readonly string[],
): number {
  const kind = versionClass(filename, terms, requested);
  const instrument = instrumentPartRank(filename, titleTokens, instrumentTerms) === 1;
  if (instrument && kind !== "requested") return 3;
  if (kind === "requested") return 0;
  if (kind === "clean") return 1;
  return 2;
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

  const versionDiff = a.versionRank - b.versionRank;
  if (versionDiff !== 0) return versionDiff;

  const artistDiff = Number(b.artistMatch) - Number(a.artistMatch);
  if (artistDiff !== 0) return artistDiff;

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

const REMOVAL_ORDER = [
  "locked",
  "junk",
  "extensions",
  "min_file_size",
  "max_file_size",
  "max_duration",
  "max_sample_rate",
  "max_bit_depth",
  "title_mismatch",
] as const satisfies readonly (keyof FilterRemovalCounts)[];

function emptyRemovals(): FilterRemovalCounts {
  return {
    locked: 0,
    junk: 0,
    extensions: 0,
    min_file_size: 0,
    max_file_size: 0,
    max_duration: 0,
    max_sample_rate: 0,
    max_bit_depth: 0,
    title_mismatch: 0,
  };
}

function removalTotal(removed: FilterRemovalCounts): number {
  return REMOVAL_ORDER.reduce((sum, key) => sum + removed[key], 0);
}

/** First matching filter wins, so the counts add up to the number of removed candidates. */
function firstRejection(
  row: Candidate,
  opts: SelectSearchOptions,
  floor: number | null,
  cap: number | null,
  maxSampleRate: number | null,
  maxBitDepth: number | null,
  titleTokens: readonly string[] | null,
): keyof FilterRemovalCounts | null {
  if (row.lockedFile) return "locked";
  if (isJunkPath(row.filename)) return "junk";
  if (!allowed(row, opts.allowedExtensions)) return "extensions";
  if (floor !== null && row.size < floor) return "min_file_size";
  if (cap !== null && row.size > cap) return "max_file_size";
  if (!withinDuration(row.lengthSeconds, opts.maxDurationSeconds)) return "max_duration";
  if (maxSampleRate !== null && row.sampleRate !== undefined && row.sampleRate > maxSampleRate) return "max_sample_rate";
  if (maxBitDepth !== null && row.bitDepth !== undefined && row.bitDepth > maxBitDepth) return "max_bit_depth";
  if (titleTokens && !hasEveryToken(row.filename, titleTokens)) return "title_mismatch";
  return null;
}

export function removalReason(removed: FilterRemovalCounts): string {
  const parts = REMOVAL_ORDER.map((key) => `${key}=${removed[key]}`);
  return `no_suitable_result: ${parts.join(", ")}`;
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
 * Pick one usable search response file, or explain why there is no pick.
 * Deterministic for the same payload. Ranking order is documented on this module.
 * Filters run once. An empty kept set is not retried with looser rules.
 */
export function selectSearch(payload: unknown, opts: SelectSearchOptions = {}): SearchSelection {
  if (responsesFrom(payload).length === 0) return { outcome: "no_responses" };
  const terms = opts.versionPenaltyTerms ?? DEFAULT_VERSION_PENALTY_TERMS;
  const instrumentTerms = opts.instrumentPartBasenames ?? DEFAULT_INSTRUMENT_PART_BASENAMES;
  const floor = sizeBytes(opts.minFileSizeMb, DEFAULT_MIN_FILE_SIZE_MB);
  const cap = sizeBytes(opts.maxFileSizeMb, DEFAULT_MAX_FILE_SIZE_MB);
  const maxSampleRate = resolveCap(opts.maxSampleRate, DEFAULT_MAX_SAMPLE_RATE);
  const maxBitDepth = resolveCap(opts.maxBitDepth, DEFAULT_MAX_BIT_DEPTH);
  const titleTokens = requiredTitleTokens(opts, terms);
  const removed = emptyRemovals();
  const kept: Candidate[] = [];
  for (const row of collectCandidates(payload)) {
    const rejection = firstRejection(row, opts, floor, cap, maxSampleRate, maxBitDepth, titleTokens);
    if (rejection) removed[rejection] += 1;
    else kept.push(row);
  }
  if (kept.length === 0) {
    if (removalTotal(removed) === 0) return { outcome: "no_usable_candidate" };
    return { outcome: "no_suitable_result", removed, reason: removalReason(removed) };
  }
  const requested = requestedText(opts);
  const artists = artistTokens(opts);
  for (const row of kept) {
    row.versionRank = contentTier(row.filename, terms, requested, titleTokens, instrumentTerms);
    row.artistMatch = artists.length > 0 && hasEveryToken(row.filename, artists);
  }
  const medians = mediansByExtension(kept);
  kept.sort((a, b) => compareCandidates(a, b, medians, maxSampleRate, maxBitDepth));
  const best = kept[0];
  if (!best) return { outcome: "no_usable_candidate" };
  return { outcome: "selected", file: toSelected(best) };
}

/**
 * Pick one usable search response file. Deterministic for the same payload.
 * Returns null when nothing usable is present, including when filters removed
 * every candidate. Does not relax filters.
 */
export function selectSearchResult(payload: unknown, opts: SelectSearchOptions = {}): SelectedSearchFile | null {
  const decision = selectSearch(payload, opts);
  return decision.outcome === "selected" ? decision.file : null;
}

export function isSearchComplete(payload: unknown): boolean {
  const rec = asRecord(payload);
  if (!rec) return false;
  if (rec.isComplete === true) return true;
  const state = str(rec.state) ?? str(rec.State);
  if (!state) return false;
  return /\bcompleted\b/i.test(state);
}
