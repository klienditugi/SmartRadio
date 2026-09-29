/**
 * Deterministic pick among CandidateTrack values.
 * No provider types and no LLM. Same tracks and policy always return the same pick.
 *
 * Hard rejects run first. Survivors are compared in order, and the comparison
 * stops at the first difference. There is no summed score and no size curve.
 *
 * Rejects, before any ranking:
 *   locked, junk paths, extensions, mp3_only / flac_only,
 *   files under min_file_size_mb,
 *   wrong title (the phrase must start at a boundary in the original basename;
 *   punctuation is spaces only for that comparison, and anything after the
 *   phrase is allowed; a closing ) or ] , or the requested artist name, is
 *   also a boundary), a medley (two other songs joined by ` _ `, ` / `, ` | `,
 *   ` + `, or a tight capitalised hyphen, or the whole word mashup, mash up,
 *   segue, transition, vs, or versus in the basename; vs or versus also counts
 *   in a folder the artist was taken from), a tribute, the word cover in the
 *   basename, or the whole word cover or covers in any folder, a different
 *   artist leading the basename when this artist is only
 *   a bare bracket credit or only in folders, stems (including the whole word
 *   drumless in the basename or a folder), an unaccepted version (class other,
 *   or a basename whole word
 *   intro, outro, instrumental, recut, re-cut, bootleg, or 2k plus two digits;
 *   a reject label wins over remix, club, extended, radio edit, album, or
 *   original; folders do not trigger these labels), long-recording phrases,
 *   bitrate under 128 kbps,
 *   files over max_file_size_mb (default 30 MiB), duration, sample rate, bit depth,
 *   and a short recording (same detector as before: under 90s, or under 0.6 of the
 *   median once five lengths are known).
 *
 * Ranking of whoever is left:
 *   1. explicit requested version (this turns the saved preference off)
 *   2. version class
 *   3. acceptable quality over poor
 *   4. format preference
 *   5. free upload slot, then shorter queue, then higher upload speed
 *   6. username, then path
 *
 * Default version order (`balanced`, also the default of `version_preference`):
 * remix, club, and extended are equal and first; then album or original
 * (an unmarked file counts here); then radio edit; then anything else.
 * A saved original, radio_edit, extended, or remix value moves that class to
 * the front. The rest stay in the default order. Club mix is the extended class.
 * A hybrid title keeps the most derived marker, so a club remix is a remix.
 * Version class and an explicit version match use the basename only.
 * A folder does not set the class. An unmarked file is original, and it is
 * not an explicit Original Mix match.
 *
 * Acceptable quality is 192 kbps or more CBR, an MP3 VBR average around 170 kbps
 * or more, or lossless FLAC. 128–191 kbps CBR is poor. An MP3 with no usable
 * bitrate uses size and length when both are known, and is poor otherwise.
 * A file with no positive size never reaches this module: the adapter drops it.
 * Unknown duration is not short and is not over the duration cap.
 *
 * If nothing survives, the result is no_suitable_result. The worker fails the
 * request with that reason. It does not enqueue.
 */

import {
  DEFAULT_BITRATE_FLOOR_KBPS,
  DEFAULT_FORMAT_PREFERENCE,
  DEFAULT_SHORT_RECORDING_FLOOR_SECONDS,
  DEFAULT_SHORT_RECORDING_FRACTION,
  DEFAULT_SHORT_RECORDING_MIN_SAMPLES,
  DEFAULT_SHORT_RECORDING_PENALTY,
  DEFAULT_INSTRUMENT_PART_BASENAMES,
  DEFAULT_LONG_RECORDING_PHRASES,
  DEFAULT_MAX_BIT_DEPTH,
  DEFAULT_MAX_DURATION_SECONDS,
  DEFAULT_MAX_FILE_SIZE_MB,
  DEFAULT_MAX_SAMPLE_RATE,
  DEFAULT_MIN_FILE_SIZE_MB,
  DEFAULT_VERSION_PENALTY_TERMS,
  DEFAULT_VERSION_PREFERENCE,
  type FormatPreference,
  type VersionPreference,
} from "@subwave-ai/shared";
import type { CandidateTrack } from "./candidate.js";

const MIB = 1024 * 1024;
const BITRATE_REJECT_BELOW = 128;
const BITRATE_VBR_ACCEPTABLE = 170;
const BITRATE_KNOWN_MIN = 32;
const BITRATE_KNOWN_MAX = 320;

/** Version terms that mean "this is not a full mix" rather than a desirable remix. */
const STEM_VERSION_TERMS = ["stem", "stems", "multitrack", "acapella", "a cappella", "acappella", "drumless"] as const;

const TITLE_STOPWORDS = new Set(["a", "an", "the", "and", "of", "feat", "ft"]);
const CREDIT_WORDS = new Set(["feat", "ft", "featuring", "and"]);

const DISC_NUMBER = /^(?:cd|disc|disk)\s*\d*$/i;

/**
 * Basename phrases, longest first when stripped. The parent folder is a weaker
 * copy of the same list. A bare "mix" is not in here.
 */
const RADIO_EDIT_PHRASES = ["radio edit", "radio version", "radio mix", "single edit", "single version"] as const;
const EXTENDED_PHRASES = [
  "extended mix",
  "extended version",
  "club mix",
  "12 inch version",
  "12 inch",
  "12 version",
  "extended",
] as const;
const ORIGINAL_PHRASES = ["original mix", "original version", "album version", "original"] as const;
const OTHER_VERSION_PHRASES = [
  "live",
  "instrumental",
  "karaoke",
  "cover",
  "demo",
  "acapella",
  "a cappella",
  "acappella",
  "stem",
  "stems",
  "multitrack",
] as const;
const REMIX_WORDS = ["remix", "rmx"] as const;
/**
 * Derived markers. Any hit is a remix (or, for a plain club mix, extended)
 * and clears `original` and `radio_edit`, even when the same name also says
 * original, vocal, radio edit, or edit.
 */
const DERIVED_VERSION_PHRASES = [
  ...REMIX_WORDS,
  "mashup",
  "mash up",
  "vs",
  "mixshow",
  "rework",
  "re edit",
  "reedit",
  "mix by",
  "mixed by",
] as const;
/** `<name> version` / `<name> edit` is a remix unless the name is one of these. */
const NAMED_EDIT_EXCLUSIONS = new Set(["radio", "single", "album", "original", "extended", "inch", "12"]);
const NAMED_PRODUCER_EDIT_SUFFIXES = new Set(["edit", "version"]);
/**
 * "club mix" stays extended. Any other "club" is the same conflict: never
 * original or radio edit. "club remix" is already covered by the remix word.
 */
const CLUB_MARKERS = ["club"] as const;
const BARE_MIX_EXCEPTIONS = ["radio mix", "club mix", "original mix", "extended mix"] as const;

/** Removed from required title tokens so a requested version is a rank, not a filter. */
const TITLE_STRIP_PHRASES = [
  ...RADIO_EDIT_PHRASES,
  ...EXTENDED_PHRASES,
  ...ORIGINAL_PHRASES,
  ...OTHER_VERSION_PHRASES,
  ...DERIVED_VERSION_PHRASES,
  ...CLUB_MARKERS,
] as const;

/** Legacy request terms skipped once a version kind was recognized, so "radio edit" does not also mean every "edit". */
const CLASSIFIED_OVERLAP = new Set(["remix", "edit", "extended", "radio edit"]);

/** Spaced joins only. A bare underscore is a space, not a medley separator. ` - ` is not one either. */
const MEDLEY_SPLIT = / _ | \/ | \| | \+ |\b(?:medley|megamix)\b/i;
/**
 * `Get Lucky-Freak Out-Another Star`. The capital after the hyphen starts the next title.
 * Case-sensitive on purpose, so `daft_punk-get_lucky` and `my-free-mp3` are not joins.
 * Spaced ` - ` stays a normal artist/title separator.
 */
const TIGHT_TITLE_HYPHEN = /(?<=[A-Za-z])-(?=[A-Z])/;

export const SCORE_COMPONENTS = [
  "requestedVersion",
  "titleMatch",
  "artistInPath",
  "format",
  "quality",
  "versionPreference",
  "sizeOvershoot",
  "durationOvershoot",
  "longRecording",
  "shortRecording",
  "stem",
  "availability",
] as const;

export type ScoreComponent = (typeof SCORE_COMPONENTS)[number];

/** Diagnostic flags. Ranking does not add these up. 1 means the file has that property. */
export type ScoreBreakdown = Record<ScoreComponent, number>;

export type QualitySignal = {
  /** `derived` is size/duration only, and only when no reported quality field was usable. */
  quality: "reported" | "derived" | "unknown";
  derivedBitrateKbps?: number;
};

export type VersionClass = "remix" | "extended" | "original" | "radio_edit" | "other";

export type TrackScore = {
  pick: CandidateTrack;
  breakdown: ScoreBreakdown;
  total: number;
  signals: QualitySignal;
  versionClass: VersionClass;
};

export type FilterRemovalCounts = {
  locked: number;
  junk: number;
  extensions: number;
  format_preference: number;
  min_file_size: number;
  max_file_size: number;
  max_duration: number;
  max_sample_rate: number;
  max_bit_depth: number;
  title_mismatch: number;
  medley: number;
  tribute_or_cover: number;
  artist_mismatch: number;
  stem: number;
  unaccepted_version: number;
  long_recording: number;
  under_bitrate: number;
  short_recording: number;
};

const REMOVAL_ORDER = [
  "locked",
  "junk",
  "extensions",
  "format_preference",
  "min_file_size",
  "max_file_size",
  "max_duration",
  "max_sample_rate",
  "max_bit_depth",
  "title_mismatch",
  "medley",
  "tribute_or_cover",
  "artist_mismatch",
  "stem",
  "unaccepted_version",
  "long_recording",
  "under_bitrate",
  "short_recording",
] as const satisfies readonly (keyof FilterRemovalCounts)[];

export type SelectionQuery = {
  artist?: string;
  title?: string;
  text?: string;
};

export type SelectionPolicyInput = {
  allowedExtensions?: readonly string[];
  /** Mebibytes. Omit for 1. `null` disables the floor. */
  minFileSizeMb?: number | null;
  /** Mebibytes. Omit for 30. `null` disables the cap. */
  maxFileSizeMb?: number | null;
  /** Seconds. Omit for 1200. `null` disables the hard cap. Missing duration stays eligible. */
  maxDurationSeconds?: number | null;
  /** Hz. Omit for 48000. `null` disables the cap. A missing sample rate stays eligible. */
  maxSampleRate?: number | null;
  /** Omit for 24. `null` disables the cap. A missing bit depth stays eligible. */
  maxBitDepth?: number | null;
  /**
   * Accepted so older callers still compile. The selector does not grade size.
   * The hard max is the only size gate.
   */
  preferredMaxFileSizeMb?: number | null;
  /** Accepted so older callers still compile. Not used for ranking or rejection. */
  preferredMaxDurationSeconds?: number | null;
  /** Omit for `balanced`, which is the default class order. */
  versionPreference?: VersionPreference;
  /** Omit for `prefer_mp3`. `mp3_only` / `flac_only` filter after the extension allowlist. */
  formatPreference?: FormatPreference;
  /** kbps. Omit for 192. CBR at or above this is acceptable. */
  bitrateFloorKbps?: number;
  /** Fraction of the search median. Omit for 0.6. */
  shortRecordingFraction?: number;
  /** Known lengths required before the median fraction applies. Omit for 5. */
  shortRecordingMinSamples?: number;
  /** Seconds. Omit for 90. Known durations below this are short without a median. */
  shortRecordingFloorSeconds?: number;
  /** Zero disables the short-recording reject. Any other value keeps the reject. */
  shortRecordingPenalty?: number;
  /**
   * Known durations of the correlated candidates in this search, including this file.
   * `selectTracks` fills this from the files that passed the other hard filters.
   */
  cohortDurationSeconds?: readonly number[];
  versionPenaltyTerms?: readonly string[];
  instrumentPartBasenames?: readonly string[];
  longRecordingPhrases?: readonly string[];
  query?: SelectionQuery;
  context?: SelectionQuery;
};

type ResolvedPolicy = {
  allowedExtensions?: readonly string[];
  minFileSizeMb: number | null;
  maxFileSizeMb: number | null;
  maxDurationSeconds: number | null;
  maxSampleRate: number | null;
  maxBitDepth: number | null;
  versionPreference: VersionPreference;
  formatPreference: FormatPreference;
  bitrateFloorKbps: number;
  shortRecordingFraction: number;
  shortRecordingMinSamples: number;
  shortRecordingFloorSeconds: number;
  shortRecordingPenalty: number;
  versionPenaltyTerms: readonly string[];
  instrumentPartBasenames: readonly string[];
  longRecordingPhrases: readonly string[];
  query: SelectionQuery;
};

export type TrackSelection =
  | ({ outcome: "selected"; removed: FilterRemovalCounts } & TrackScore)
  | { outcome: "no_suitable_result"; removed: FilterRemovalCounts; reason: string };

type VersionMarks = {
  radio_edit: boolean;
  extended: boolean;
  remix: boolean;
  /** Explicit original / album-version phrasing. A clean title is separate. */
  original: boolean;
  /** Live, stem, bare "mix", dangling "edit", and the other non-original terms. */
  other: boolean;
};

function resolveOptionalCap(value: number | null | undefined, fallback: number): number | null {
  if (value === null) return null;
  const cap = value === undefined ? fallback : value;
  if (!Number.isFinite(cap) || cap <= 0) return null;
  return cap;
}

export function resolveSelectionPolicy(input: SelectionPolicyInput = {}): ResolvedPolicy {
  return {
    allowedExtensions: input.allowedExtensions,
    minFileSizeMb: resolveOptionalCap(input.minFileSizeMb, DEFAULT_MIN_FILE_SIZE_MB),
    maxFileSizeMb: resolveOptionalCap(input.maxFileSizeMb, DEFAULT_MAX_FILE_SIZE_MB),
    maxDurationSeconds: resolveOptionalCap(input.maxDurationSeconds, DEFAULT_MAX_DURATION_SECONDS),
    maxSampleRate: resolveOptionalCap(input.maxSampleRate, DEFAULT_MAX_SAMPLE_RATE),
    maxBitDepth: resolveOptionalCap(input.maxBitDepth, DEFAULT_MAX_BIT_DEPTH),
    versionPreference: input.versionPreference ?? DEFAULT_VERSION_PREFERENCE,
    formatPreference: input.formatPreference ?? DEFAULT_FORMAT_PREFERENCE,
    bitrateFloorKbps: resolveOptionalCap(input.bitrateFloorKbps, DEFAULT_BITRATE_FLOOR_KBPS) ?? DEFAULT_BITRATE_FLOOR_KBPS,
    shortRecordingFraction: input.shortRecordingFraction ?? DEFAULT_SHORT_RECORDING_FRACTION,
    shortRecordingMinSamples: input.shortRecordingMinSamples ?? DEFAULT_SHORT_RECORDING_MIN_SAMPLES,
    shortRecordingFloorSeconds: input.shortRecordingFloorSeconds ?? DEFAULT_SHORT_RECORDING_FLOOR_SECONDS,
    shortRecordingPenalty: input.shortRecordingPenalty ?? DEFAULT_SHORT_RECORDING_PENALTY,
    versionPenaltyTerms: input.versionPenaltyTerms ?? DEFAULT_VERSION_PENALTY_TERMS,
    instrumentPartBasenames: input.instrumentPartBasenames ?? DEFAULT_INSTRUMENT_PART_BASENAMES,
    longRecordingPhrases: input.longRecordingPhrases ?? DEFAULT_LONG_RECORDING_PHRASES,
    query: { ...input.context, ...input.query },
  };
}

function emptyBreakdown(): ScoreBreakdown {
  return {
    requestedVersion: 0,
    titleMatch: 0,
    artistInPath: 0,
    format: 0,
    quality: 0,
    versionPreference: 0,
    sizeOvershoot: 0,
    durationOvershoot: 0,
    longRecording: 0,
    shortRecording: 0,
    stem: 0,
    availability: 0,
  };
}

function emptyRemovals(): FilterRemovalCounts {
  return {
    locked: 0,
    junk: 0,
    extensions: 0,
    format_preference: 0,
    min_file_size: 0,
    max_file_size: 0,
    max_duration: 0,
    max_sample_rate: 0,
    max_bit_depth: 0,
    title_mismatch: 0,
    medley: 0,
    tribute_or_cover: 0,
    artist_mismatch: 0,
    stem: 0,
    unaccepted_version: 0,
    long_recording: 0,
    under_bitrate: 0,
    short_recording: 0,
  };
}

export function removalReason(removed: FilterRemovalCounts): string {
  return `no_suitable_result: ${REMOVAL_ORDER.map((key) => `${key}=${removed[key]}`).join(", ")}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeMatchText(value: string): string {
  const folded = value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const withoutApostrophes = folded.replace(/[''`´]/g, "");
  return withoutApostrophes.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function dropBracketedCredits(title: string): string {
  return title.replace(/[\[({][^\]\)}]*\b(?:feat|ft)\.?\b[^\]\)}]*[\]\)}]/gi, " ");
}

function significantTokens(normalized: string): string[] {
  const tokens = normalized ? normalized.split(" ") : [];
  if (tokens.length === 0) return [];
  const withoutStops = tokens.filter((token) => !TITLE_STOPWORDS.has(token));
  const base = withoutStops.length > 0 ? withoutStops : tokens;
  if (base.some((token) => token.length > 1)) return base.filter((token) => token.length > 1);
  return base;
}

function hasPhrase(text: string, phrase: string): boolean {
  const normalized = normalizeMatchText(phrase);
  if (!normalized) return false;
  return new RegExp(`\\b${escapeRegExp(normalized)}\\b`, "i").test(text);
}

function hasAnyPhrase(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => hasPhrase(text, phrase));
}

function textHasToken(haystack: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(haystack);
}

function hasEveryToken(text: string, tokens: readonly string[]): boolean {
  return tokens.every((token) => textHasToken(text, token));
}

function stripVersionTerms(normalized: string, terms: readonly string[]): string {
  const phrases = terms
    .map((term) => normalizeMatchText(term))
    .filter((term) => term.length > 0)
    .sort((a, b) => b.length - a.length);
  let text = normalized;
  for (const phrase of phrases) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "gi"), " ");
  }
  return text.replace(/\s+/g, " ").trim();
}

function pathText(track: CandidateTrack): string {
  return normalizeMatchText([track.basename, ...track.folders].join(" "));
}

function basenameText(track: CandidateTrack): string {
  return normalizeMatchText(track.basename.replace(/\.[^.]+$/, ""));
}

function rawBasename(track: CandidateTrack): string {
  return track.basename.replace(/\.[^.]+$/, "");
}

function parentText(track: CandidateTrack): string {
  const parent = track.folders[track.folders.length - 1];
  return parent ? normalizeMatchText(parent) : "";
}

function albumFolderRaw(track: CandidateTrack): string {
  return track.folders[track.folders.length - 1] ?? "";
}

function requestedBlob(query: SelectionQuery): string {
  const title = typeof query.title === "string" ? dropBracketedCredits(query.title) : "";
  return normalizeMatchText(
    [query.artist, title, query.text]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join(" "),
  );
}

function requiredTitleTokens(query: SelectionQuery, terms: readonly string[]): string[] | null {
  const title = query.title;
  if (typeof title !== "string" || !title.trim()) return null;
  const tokens = significantTokens(
    stripVersionTerms(normalizeMatchText(dropBracketedCredits(title)), [...TITLE_STRIP_PHRASES, ...terms]),
  );
  return tokens.length > 0 ? tokens : null;
}

function artistTokenList(query: SelectionQuery): string[] {
  if (typeof query.artist !== "string" || !query.artist.trim()) return [];
  return significantTokens(normalizeMatchText(query.artist));
}

function artistPhrasePattern(artist: string): string {
  return artist
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => escapeRegExp(part))
    .join("\\s+");
}

function isJunkPath(path: string): boolean {
  const parts = path.split(/[/\\]/).filter((part) => part.length > 0);
  const base = parts[parts.length - 1] ?? path;
  if (base.toLowerCase().startsWith("._")) return true;
  return parts.some((part) => part.toLowerCase() === "__macosx");
}

function extensionAllowed(track: CandidateTrack, allowed?: readonly string[]): boolean {
  if (!allowed || allowed.length === 0) return true;
  const ext = track.format.ext.toLowerCase();
  if (!ext) return false;
  return allowed.some((item) => item.toLowerCase() === ext);
}

function formatRejected(track: CandidateTrack, preference: FormatPreference): boolean {
  if (preference === "mp3_only") return track.format.ext !== ".mp3";
  if (preference === "flac_only") return track.format.ext !== ".flac";
  return false;
}

function withinHardDuration(track: CandidateTrack, maxSeconds: number | null): boolean {
  if (maxSeconds === null) return true;
  if (track.durationSeconds === undefined) return true;
  return track.durationSeconds <= maxSeconds;
}

function isDiscNumberPhrase(phrase: string): boolean {
  return DISC_NUMBER.test(normalizeMatchText(phrase));
}

/**
 * Long-recording phrases match the basename, and the immediate parent folder.
 * Disc numbering never matches, including a phrase that is only `cd` / `disc`.
 * A bare `mix` never matches. `ep.` matches `ep` plus a number.
 */
export function matchesLongRecording(track: CandidateTrack, phrases: readonly string[]): boolean {
  const targets = [basenameText(track), parentText(track)].filter((text) => text.length > 0);
  for (const phrase of phrases) {
    const raw = phrase.trim().toLowerCase();
    if (!raw || isDiscNumberPhrase(phrase) || normalizeMatchText(phrase) === "mix") continue;
    const epNumber = raw === "ep." || raw === "ep";
    for (const text of targets) {
      if (epNumber) {
        if (/\bep\s+\d+\b/i.test(text)) return true;
        continue;
      }
      if (hasPhrase(text, phrase)) return true;
    }
  }
  return false;
}

function matchedTerms(text: string, terms: readonly string[]): string[] {
  const found: string[] = [];
  for (const term of terms) {
    if (hasPhrase(text, term)) found.push(term);
  }
  return found;
}

function sameTerm(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** The token before "edit" or "version" names a producer, so this is a re-edit. */
function hasNamedProducerEdit(text: string): boolean {
  const tokens = text ? text.split(" ") : [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const name = tokens[i] ?? "";
    const next = tokens[i + 1] ?? "";
    if (!NAMED_PRODUCER_EDIT_SUFFIXES.has(next)) continue;
    if (!name || NAMED_EDIT_EXCLUSIONS.has(name) || /^\d+$/.test(name)) continue;
    return true;
  }
  return false;
}

/**
 * Version marks on already-normalized text. The most specific marker wins.
 * A derived marker (remix, club, mix by, mashup, "vs", mixshow,
 * rework, or a named-producer edit) is remix or extended/club, never original
 * or radio edit, even when the name also says original, vocal, radio edit, or edit.
 * "original vocal" inside that title is not an original.
 * A plain Original Mix, Album Version, Extended Mix, Radio Edit, or Club Mix
 * with no conflicting marker keeps its class. A plain club mix stays extended.
 * A bare "mix" is not a remix and is not a clean title.
 */
export function classifyVersionText(text: string): VersionMarks {
  let radio_edit = hasAnyPhrase(text, RADIO_EDIT_PHRASES);
  let extended = hasAnyPhrase(text, EXTENDED_PHRASES);
  let original = hasAnyPhrase(text, ORIGINAL_PHRASES);
  const derived = hasNamedProducerEdit(text) || hasAnyPhrase(text, DERIVED_VERSION_PHRASES);
  const club = hasAnyPhrase(text, CLUB_MARKERS);
  if (derived || club) {
    radio_edit = false;
    original = false;
  }
  if (club && !derived) extended = true;
  const remix = derived;
  const bareMix = hasPhrase(text, "mix") && !hasAnyPhrase(text, BARE_MIX_EXCEPTIONS);
  const danglingEdit = hasPhrase(text, "edit") && !radio_edit && !remix && !original && !extended;
  const other = hasAnyPhrase(text, OTHER_VERSION_PHRASES) || bareMix || danglingEdit;
  return { radio_edit, extended, remix, original, other };
}

function isCleanTitle(marks: VersionMarks): boolean {
  return !marks.radio_edit && !marks.extended && !marks.remix && !marks.original && !marks.other;
}

function versionClassFromMarks(marks: VersionMarks): VersionClass {
  if (marks.remix) return "remix";
  if (marks.extended) return "extended";
  if (marks.radio_edit) return "radio_edit";
  if (marks.original || isCleanTitle(marks)) return "original";
  return "other";
}

/**
 * Basename only. A folder named Mashup or ORIGINAL_BACKUP does not set the class.
 * An unmarked basename is original.
 */
export function fileVersionClass(track: CandidateTrack): VersionClass {
  return versionClassFromMarks(classifyVersionText(basenameText(track)));
}

/**
 * Lower is better. `balanced` is remix = extended, then original, then radio edit, then other.
 * A specific saved class moves to the front. The remaining classes keep that order.
 */
export function versionClassRank(versionClass: VersionClass, preference: VersionPreference): number {
  const fun = versionClass === "remix" || versionClass === "extended";
  if (preference === "remix") {
    if (versionClass === "remix") return 0;
    if (versionClass === "extended") return 1;
    if (versionClass === "original") return 2;
    if (versionClass === "radio_edit") return 3;
    return 4;
  }
  if (preference === "extended") {
    if (versionClass === "extended") return 0;
    if (versionClass === "remix") return 1;
    if (versionClass === "original") return 2;
    if (versionClass === "radio_edit") return 3;
    return 4;
  }
  if (preference === "original") {
    if (versionClass === "original") return 0;
    if (fun) return 1;
    if (versionClass === "radio_edit") return 2;
    return 3;
  }
  if (preference === "radio_edit") {
    if (versionClass === "radio_edit") return 0;
    if (fun) return 1;
    if (versionClass === "original") return 2;
    return 3;
  }
  if (fun) return 0;
  if (versionClass === "original") return 1;
  if (versionClass === "radio_edit") return 2;
  return 3;
}

function mentionsTitle(text: string, titleTokens: readonly string[]): boolean {
  const phrase = titleTokens.join(" ");
  if (!phrase) return false;
  return hasPhrase(normalizeMatchText(text), phrase);
}

function medleyPieces(raw: string): string[] {
  const pieces: string[] = [];
  for (const part of raw.split(MEDLEY_SPLIT)) {
    for (const tighter of part.split(TIGHT_TITLE_HYPHEN)) {
      const trimmed = tighter.trim();
      if (trimmed.length > 0) pieces.push(trimmed);
    }
  }
  return pieces;
}

function leftoverTitleTokens(piece: string, titleTokens: readonly string[], artistTokens: readonly string[]): string[] {
  const withoutCredit = piece.replace(/\b(?:feat|ft|featuring)\b[\s\S]*$/i, " ");
  const withoutTrack = withoutCredit.replace(/^\s*\d{1,4}[._)\s-]+/, "").replace(/^\s*\d{1,4}\s*$/, "");
  const normalized = stripVersionTerms(normalizeMatchText(withoutTrack), TITLE_STRIP_PHRASES);
  return significantTokens(normalized).filter(
    (token) => !titleTokens.includes(token) && !artistTokens.includes(token) && !CREDIT_WORDS.has(token) && !/^\d+$/.test(token),
  );
}

/**
 * A medley names at least two other titles beside this song, joined by
 * ` _ `, ` / `, ` | `, ` + `, or a tight capitalised hyphen (`Title-Other`),
 * or it uses the word medley / megamix.
 * One extra piece (an artist, or a single other title) is not enough.
 * A repeated title, a track number, the artist, a feat credit, and a version marker are not another title.
 * Spaced ` - ` is not a join. A lowercase hyphen (`artist-title`, a URL) is not one either.
 */
function isMedleyName(raw: string, titleTokens: readonly string[] | null, artistTokens: readonly string[]): boolean {
  if (!titleTokens || titleTokens.length === 0 || !raw.trim()) return false;
  const namesThisSong = mentionsTitle(raw, titleTokens) || medleyPieces(raw).some((piece) => mentionsTitle(piece, titleTokens));
  if (!namesThisSong) return false;
  if (/\b(?:medley|megamix)\b/i.test(raw)) return true;
  const pieces = medleyPieces(raw);
  const others = pieces.filter((piece) => leftoverTitleTokens(piece, titleTokens, artistTokens).length > 0 && !mentionsTitle(piece, titleTokens));
  return others.length >= 2;
}

function stripTributePhrases(raw: string, artist: string): string {
  const phrase = artistPhrasePattern(artist);
  if (!phrase) return raw;
  const patterns = [
    new RegExp(`\\btribute to\\s+${phrase}\\b`, "gi"),
    new RegExp(`\\b${phrase}\\s+cover\\b`, "gi"),
    new RegExp(`\\boriginally by\\s+${phrase}\\b`, "gi"),
    new RegExp(`\\bin the style of\\s+${phrase}\\b`, "gi"),
    new RegExp(`\\bmade famous by\\s+${phrase}\\b`, "gi"),
    new RegExp(`\\bcovered by\\s+${phrase}\\b`, "gi"),
    new RegExp(`\\bcover of\\s+${phrase}\\b`, "gi"),
  ];
  let text = raw;
  for (const pattern of patterns) text = text.replace(pattern, " ");
  return text;
}

function differentArtistLeads(rawBase: string, artistTokens: readonly string[], titleTokens: readonly string[] | null): boolean {
  const withoutTrack = rawBase.replace(/^\s*\d{1,4}[._)\s-]+/, "");
  const parts = withoutTrack.split(/\s+[-–—]\s+/);
  if (parts.length < 2) return false;
  const lead = parts[0] ?? "";
  if (!/[a-z]/i.test(lead)) return false;
  const leadTokens = significantTokens(stripVersionTerms(normalizeMatchText(lead), TITLE_STRIP_PHRASES));
  if (leadTokens.length === 0) return false;
  if (titleTokens && titleTokens.length > 0 && titleTokens.every((token) => leadTokens.includes(token))) return false;
  if (artistTokens.length > 0 && artistTokens.every((token) => leadTokens.includes(token))) return false;
  return true;
}

/** Longest first so `_-_` is not also read as a bare hyphen in the middle of the separator. */
const TITLE_SEPARATORS = ["_-_", " - ", " – ", " — ", "–", "—", "-"] as const;

/**
 * Where a title phrase may begin in the original basename: the start, after a
 * track number (`08 `, `08-`, `201-`, `1 - `, `10A - 117 - `), after an artist
 * separator, after `(` / `[`, or after a closing `)` / `]` and its trailing
 * whitespace. The index is into the original string.
 */
function titleBoundaryIndexes(original: string): number[] {
  const starts = new Set<number>([0]);
  for (const separator of TITLE_SEPARATORS) {
    let from = 0;
    while (from < original.length) {
      const at = original.indexOf(separator, from);
      if (at < 0) break;
      starts.add(at + separator.length);
      from = at + separator.length;
    }
  }
  for (let i = 0; i < original.length; i++) {
    const ch = original[i] ?? "";
    if (ch === "(" || ch === "[") starts.add(i + 1);
    if (ch === ")" || ch === "]") {
      let next = i + 1;
      while (next < original.length && /\s/.test(original[next] ?? "")) next += 1;
      starts.add(next);
    }
  }
  // The predecessor stays outside the match so `01-08_` and `10A - 117 - ` each
  // yield a boundary after the number that actually leads the following text.
  const trackNumber = /(\d{1,4}[A-Za-z]?)([.\s_\-–—]+)/g;
  for (const match of original.matchAll(trackNumber)) {
    const index = match.index ?? 0;
    if (index > 0 && /[A-Za-z0-9]/.test(original[index - 1] ?? "")) continue;
    starts.add(index + match[0].length);
  }
  return [...starts].filter((index) => index >= 0 && index <= original.length);
}

function startsWithTitlePhrase(originalSlice: string, phrase: string): boolean {
  const normalized = normalizeMatchText(originalSlice);
  return normalized === phrase || normalized.startsWith(`${phrase} `);
}

function titleAtBoundary(original: string, phrase: string): boolean {
  return titleBoundaryIndexes(original).some((index) => startsWithTitlePhrase(original.slice(index), phrase));
}

/** The title phrase starts immediately after the artist in the normalized basename. */
function titleDirectlyAfterArtist(normalizedBase: string, artistPhrase: string, titlePhrase: string): boolean {
  if (!artistPhrase || !titlePhrase) return false;
  const pattern = new RegExp(
    `(?:^| )${escapeRegExp(artistPhrase)} (?=${escapeRegExp(titlePhrase)}(?: |$))`,
    "i",
  );
  return pattern.test(normalizedBase);
}

/**
 * The title phrase must start at a boundary in the original basename.
 * Punctuation is normalized only for the comparison. Anything after the phrase
 * is allowed. The requested artist name in the normalized basename is also a
 * boundary when the title follows it directly. A folder supplies the title
 * only when the basename lacks it.
 */
function titleEvidence(track: CandidateTrack, titleTokens: readonly string[] | null, artistTokens: readonly string[]): boolean {
  if (!titleTokens || titleTokens.length === 0) return true;
  const phrase = titleTokens.join(" ");
  const base = rawBasename(track);
  if (titleAtBoundary(base, phrase)) return true;
  if (titleDirectlyAfterArtist(basenameText(track), artistTokens.join(" "), phrase)) return true;
  if (hasPhrase(basenameText(track), phrase)) return false;
  return track.folders.some((folder) => titleAtBoundary(folder, phrase));
}

/** Whole word in the basename. `Discover` and `Coverage` do not match. */
function basenameHasCoverWord(track: CandidateTrack): boolean {
  return /\bcovers?\b/.test(basenameText(track));
}

/** Whole word `cover` or `covers` in any folder segment. `Discover` and `Coverage` do not match. */
function folderHasCoverWord(track: CandidateTrack): boolean {
  return track.folders.some((folder) => /\bcovers?\b/.test(normalizeMatchText(folder)));
}

/**
 * Whole word or phrase in the basename only. `mash-up` normalizes to `mash up`,
 * and `vs.` normalizes to `vs`. A folder name does not count, except the
 * artist-folder case below.
 * bootleg, edit, remix, x, feat, and ft do not.
 */
const MEDLEY_BASENAME_PHRASES = ["mashup", "mash up", "segue", "transition", "versus", "vs"] as const;

function basenameHasMedleyWord(track: CandidateTrack): boolean {
  return hasAnyPhrase(basenameText(track), MEDLEY_BASENAME_PHRASES);
}

/**
 * The basename does not name the artist, so the artist is read from a folder.
 * Whole-word vs/versus in that same folder segment is the basename medley rule.
 * A vs folder that does not carry the artist, and a basename that already names
 * the artist, are left alone.
 */
/**
 * Version words that keep a remixer-first name (or a bracketed remix credit)
 * out of the bare-credit cover rule. A folder is not read.
 */
const BRACKET_CREDIT_VERSION_WORDS = [
  "remix",
  "rmx",
  "mix",
  "club",
  "extended",
  "edit",
  "re edit",
  "reedit",
  "rework",
  "dub",
  "bootleg",
] as const;

function bracketGroups(raw: string): string[] {
  const groups: string[] = [];
  for (const match of raw.matchAll(/\(([^)]*)\)|\[([^\]]*)\]|\{([^}]*)\}/g)) {
    groups.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return groups;
}

/** The bracket holds the artist name and nothing else, as in `[Daft Punk]` or `(Daft Punk)`. */
function isBareArtistCredit(group: string, artistTokens: readonly string[]): boolean {
  const tokens = significantTokens(normalizeMatchText(group));
  return tokens.length === artistTokens.length && artistTokens.every((token) => tokens.includes(token));
}

/**
 * A different artist leads `<Other Artist> - <Title>`, and the requested artist
 * appears only as a bare `[Artist]` or `(Artist)` credit. A version word in
 * that bracket or anywhere else in the basename keeps the file (a remixer
 * credit). Folders are not read.
 */
function bareBracketArtistCredit(
  rawBase: string,
  artistTokens: readonly string[],
  titleTokens: readonly string[] | null,
): boolean {
  if (artistTokens.length === 0) return false;
  if (!differentArtistLeads(rawBase, artistTokens, titleTokens)) return false;
  const normalized = normalizeMatchText(rawBase);
  if (hasAnyPhrase(normalized, BRACKET_CREDIT_VERSION_WORDS)) return false;
  if (!hasEveryToken(normalized, artistTokens)) return false;
  const holdingArtist = bracketGroups(rawBase).filter((group) => hasEveryToken(normalizeMatchText(group), artistTokens));
  if (holdingArtist.length === 0 || !holdingArtist.every((group) => isBareArtistCredit(group, artistTokens))) return false;
  const outside = rawBase.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ");
  return !hasEveryToken(normalizeMatchText(outside), artistTokens);
}

function artistTakenFromVsFolder(track: CandidateTrack, artistTokens: readonly string[]): boolean {
  if (artistTokens.length === 0) return false;
  if (hasEveryToken(basenameText(track), artistTokens)) return false;
  return track.folders.some((folder) => {
    const text = normalizeMatchText(folder);
    if (!hasEveryToken(text, artistTokens)) return false;
    return hasPhrase(text, "vs") || hasPhrase(text, "versus");
  });
}

function identityRejection(
  track: CandidateTrack,
  policy: ResolvedPolicy,
  titleTokens: readonly string[] | null,
): keyof FilterRemovalCounts | null {
  const artists = artistTokenList(policy.query);
  const artist = typeof policy.query.artist === "string" ? policy.query.artist : "";
  const base = rawBasename(track);
  if (basenameHasCoverWord(track) || folderHasCoverWord(track)) return "tribute_or_cover";
  if (titleTokens && !titleEvidence(track, titleTokens, artists)) return "title_mismatch";
  if (
    basenameHasMedleyWord(track) ||
    isMedleyName(base, titleTokens, artists) ||
    isMedleyName(albumFolderRaw(track), titleTokens, artists) ||
    artistTakenFromVsFolder(track, artists)
  ) {
    return "medley";
  }
  if (artists.length === 0) return null;
  const artistInBasename = hasEveryToken(basenameText(track), artists);
  const artistOutsideTribute = hasEveryToken(normalizeMatchText(stripTributePhrases(base, artist)), artists);
  const otherLeads = differentArtistLeads(base, artists, titleTokens);
  if (otherLeads && artistInBasename && !artistOutsideTribute) return "tribute_or_cover";
  if (bareBracketArtistCredit(base, artists, titleTokens)) return "tribute_or_cover";
  if (otherLeads && !artistInBasename) return "artist_mismatch";
  return null;
}

function knownReportedKbps(kbps: number | undefined): number | undefined {
  if (kbps === undefined || !Number.isFinite(kbps)) return undefined;
  if (kbps >= BITRATE_KNOWN_MIN && kbps <= BITRATE_KNOWN_MAX) return kbps;
  return undefined;
}

function derivedMp3Kbps(track: CandidateTrack): number | undefined {
  if (track.format.ext !== ".mp3") return undefined;
  if (track.durationSeconds === undefined || !(track.durationSeconds > 0) || !(track.sizeBytes > 0)) return undefined;
  return Math.round((track.sizeBytes * 8) / track.durationSeconds / 1000);
}

function underBitrate(track: CandidateTrack): boolean {
  if (track.format.lossless) return false;
  const reported = track.bitrateKbps;
  if (reported !== undefined && Number.isFinite(reported) && reported > 0 && reported < BITRATE_REJECT_BELOW) return true;
  if (knownReportedKbps(reported) !== undefined) return false;
  const derived = derivedMp3Kbps(track);
  return derived !== undefined && derived > 0 && derived < BITRATE_REJECT_BELOW;
}

function isShort(track: CandidateTrack, policy: ResolvedPolicy, cohort: readonly number[]): boolean {
  if (policy.shortRecordingPenalty === 0) return false;
  const duration = track.durationSeconds;
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) return false;
  if (duration < policy.shortRecordingFloorSeconds) return true;
  const known = cohort.filter((value) => Number.isFinite(value) && value > 0);
  if (known.length >= policy.shortRecordingMinSamples) {
    const relative = policy.shortRecordingFraction * medianOf(known);
    if (duration < relative) return true;
  }
  return false;
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1] ?? upper;
  return (lower + upper) / 2;
}

/** Basename whole words. A folder does not count. `2k17` is `2k` plus two digits. */
const UNACCEPTED_BASENAME_PHRASES = ["intro", "outro", "instrumental", "recut", "re cut", "bootleg"] as const;
const YEAR_EDIT = /\b2k\d{2}\b/;

/**
 * Class other is not an accepted version. The basename labels above reject
 * even when the same name is also remix, club, extended, radio edit, album,
 * or original. A clean title with none of these stays original.
 */
function unacceptedVersion(track: CandidateTrack): boolean {
  const text = basenameText(track);
  if (hasAnyPhrase(text, UNACCEPTED_BASENAME_PHRASES) || YEAR_EDIT.test(text)) return true;
  return fileVersionClass(track) === "other";
}

function incidentalStem(
  track: CandidateTrack,
  policy: ResolvedPolicy,
  titleTokens: readonly string[] | null,
  asked: readonly string[],
): boolean {
  const stemName = basenameText(track);
  const waived = Boolean(titleTokens && titleTokens.length > 0 && hasEveryToken(stemName, titleTokens));
  if (!waived) {
    const tokens = stemName.split(" ").filter((token) => token.length > 0);
    const wanted = new Set(policy.instrumentPartBasenames.map((term) => term.trim().toLowerCase()).filter(Boolean));
    if (tokens.some((token) => wanted.has(token))) return true;
  }
  const fileStemTerms = matchedTerms(pathText(track), STEM_VERSION_TERMS);
  return fileStemTerms.some((term) => !asked.some((item) => sameTerm(item, term)));
}

function firstRejection(
  track: CandidateTrack,
  policy: ResolvedPolicy,
  titleTokens: readonly string[] | null,
): keyof FilterRemovalCounts | null {
  if (track.locked) return "locked";
  if (isJunkPath(track.path)) return "junk";
  if (!extensionAllowed(track, policy.allowedExtensions)) return "extensions";
  if (formatRejected(track, policy.formatPreference)) return "format_preference";
  if (policy.minFileSizeMb !== null && track.sizeBytes < policy.minFileSizeMb * MIB) return "min_file_size";
  const identity = identityRejection(track, policy, titleTokens);
  if (identity) return identity;
  const asked = matchedTerms(requestedBlob(policy.query), policy.versionPenaltyTerms);
  if (incidentalStem(track, policy, titleTokens, asked)) return "stem";
  if (unacceptedVersion(track)) return "unaccepted_version";
  if (matchesLongRecording(track, policy.longRecordingPhrases)) return "long_recording";
  if (underBitrate(track)) return "under_bitrate";
  if (policy.maxFileSizeMb !== null && track.sizeBytes > policy.maxFileSizeMb * MIB) return "max_file_size";
  if (!withinHardDuration(track, policy.maxDurationSeconds)) return "max_duration";
  if (policy.maxSampleRate !== null && track.sampleRateHz !== undefined && track.sampleRateHz > policy.maxSampleRate) {
    return "max_sample_rate";
  }
  if (policy.maxBitDepth !== null && track.bitDepth !== undefined && track.bitDepth > policy.maxBitDepth) {
    return "max_bit_depth";
  }
  return null;
}

/** The request names a version kind, so the saved preference stays off. */
function requestNamesVersion(policy: ResolvedPolicy): boolean {
  const askedText = requestedBlob(policy.query);
  if (!askedText) return false;
  const asked = classifyVersionText(askedText);
  if (asked.radio_edit || asked.extended || asked.remix || asked.original || asked.other) return true;
  return matchedTerms(askedText, policy.versionPenaltyTerms).length > 0;
}

function requestedVersionClass(policy: ResolvedPolicy): VersionClass | null {
  if (!requestNamesVersion(policy)) return null;
  const asked = classifyVersionText(requestedBlob(policy.query));
  if (asked.remix) return "remix";
  if (asked.extended) return "extended";
  if (asked.radio_edit) return "radio_edit";
  if (asked.original) return "original";
  if (asked.other) return "other";
  return null;
}

/**
 * A version written in the request matches the basename only.
 * An unmarked file stays class original and does not count as an explicit Original Mix.
 * A folder word never satisfies the request.
 */
function explicitRequestMatches(track: CandidateTrack, policy: ResolvedPolicy): boolean {
  const wanted = requestedVersionClass(policy);
  if (!wanted) return false;
  const marks = classifyVersionText(basenameText(track));
  if (isCleanTitle(marks)) return false;
  return versionClassFromMarks(marks) === wanted;
}

/** A named request replaces the saved preference with that class. Unmarked files stay original. */
function rankingPreference(policy: ResolvedPolicy): VersionPreference {
  if (!requestNamesVersion(policy)) return policy.versionPreference;
  const wanted = requestedVersionClass(policy);
  if (wanted === "remix" || wanted === "extended" || wanted === "original" || wanted === "radio_edit") return wanted;
  return "balanced";
}

function qualityOf(track: CandidateTrack, floor: number): { acceptable: boolean; signal: QualitySignal } {
  if (track.format.lossless) {
    const known = track.bitDepth !== undefined || track.sampleRateHz !== undefined;
    return { acceptable: true, signal: { quality: known ? "reported" : "unknown" } };
  }
  const reported = knownReportedKbps(track.bitrateKbps);
  if (reported !== undefined) {
    const vbrAcceptable = track.format.ext === ".mp3" && track.vbr === true && reported >= BITRATE_VBR_ACCEPTABLE;
    return { acceptable: vbrAcceptable || reported >= floor, signal: { quality: "reported" } };
  }
  const derived = derivedMp3Kbps(track);
  if (derived !== undefined) {
    const usable = derived >= BITRATE_KNOWN_MIN && derived <= BITRATE_KNOWN_MAX;
    return {
      acceptable: usable && derived >= floor,
      signal: { quality: "derived", derivedBitrateKbps: derived },
    };
  }
  return { acceptable: false, signal: { quality: "unknown" } };
}

function formatMatches(track: CandidateTrack, preference: FormatPreference): boolean {
  if (preference === "prefer_mp3") return track.format.ext === ".mp3";
  if (preference === "prefer_flac") return track.format.ext === ".flac";
  return false;
}

export function scoreTrack(track: CandidateTrack, input: SelectionPolicyInput = {}): TrackScore {
  const policy = resolveSelectionPolicy(input);
  const titleTokens = requiredTitleTokens(policy.query, policy.versionPenaltyTerms);
  const artists = artistTokenList(policy.query);
  const versionClass = fileVersionClass(track);
  const namesVersion = requestNamesVersion(policy);
  const activePreference = rankingPreference(policy);
  const breakdown = emptyBreakdown();
  const quality = qualityOf(track, policy.bitrateFloorKbps);

  breakdown.requestedVersion = explicitRequestMatches(track, policy) ? 1 : 0;
  if (titleTokens && titleEvidence(track, titleTokens, artists)) breakdown.titleMatch = 1;
  if (artists.length > 0 && hasEveryToken(pathText(track), artists)) breakdown.artistInPath = 1;
  breakdown.format = formatMatches(track, policy.formatPreference) ? 1 : 0;
  breakdown.quality = quality.acceptable ? 1 : 0;
  breakdown.versionPreference = !namesVersion && versionClassRank(versionClass, activePreference) === 0 ? 1 : 0;

  const total = SCORE_COMPONENTS.reduce((sum, key) => sum + breakdown[key], 0);
  return { pick: track, breakdown, total, signals: quality.signal, versionClass };
}

function compareSurvivors(a: CandidateTrack, b: CandidateTrack, policy: ResolvedPolicy): number {
  const aExplicit = explicitRequestMatches(a, policy) ? 1 : 0;
  const bExplicit = explicitRequestMatches(b, policy) ? 1 : 0;
  if (aExplicit !== bExplicit) return bExplicit - aExplicit;

  const preference = rankingPreference(policy);
  const versionGap = versionClassRank(fileVersionClass(a), preference) - versionClassRank(fileVersionClass(b), preference);
  if (versionGap !== 0) return versionGap;

  const aQuality = qualityOf(a, policy.bitrateFloorKbps).acceptable ? 1 : 0;
  const bQuality = qualityOf(b, policy.bitrateFloorKbps).acceptable ? 1 : 0;
  if (aQuality !== bQuality) return bQuality - aQuality;

  const aFormat = formatMatches(a, policy.formatPreference) ? 0 : 1;
  const bFormat = formatMatches(b, policy.formatPreference) ? 0 : 1;
  if (aFormat !== bFormat) return aFormat - bFormat;

  const aFree = a.availability?.freeSlot === true ? 0 : 1;
  const bFree = b.availability?.freeSlot === true ? 0 : 1;
  if (aFree !== bFree) return aFree - bFree;

  const aQueue = a.availability?.queueLength ?? 0;
  const bQueue = b.availability?.queueLength ?? 0;
  if (aQueue !== bQueue) return aQueue - bQueue;

  const aSpeed = a.availability?.speedBps ?? 0;
  const bSpeed = b.availability?.speedBps ?? 0;
  if (aSpeed !== bSpeed) return bSpeed - aSpeed;

  const peer = a.peer.localeCompare(b.peer);
  if (peer !== 0) return peer;
  return a.path.localeCompare(b.path);
}

/**
 * Filter, then pick the first survivor in the ordered comparison.
 * Filters are not relaxed when every track is removed.
 */
export function selectTracks(tracks: readonly CandidateTrack[], input: SelectionPolicyInput = {}): TrackSelection {
  const policy = resolveSelectionPolicy(input);
  const titleTokens = requiredTitleTokens(policy.query, policy.versionPenaltyTerms);
  const removed = emptyRemovals();
  const pending: CandidateTrack[] = [];
  for (const track of tracks) {
    const rejection = firstRejection(track, policy, titleTokens);
    if (rejection) removed[rejection] += 1;
    else pending.push(track);
  }
  // Lengths come from every file that matches the song, not only the format
  // filter. A 105s remix FLAC is short next to the album copies even under flac_only.
  const lengthPolicy = { ...policy, formatPreference: "prefer_mp3" as const };
  const cohort = tracks
    .filter((track) => firstRejection(track, lengthPolicy, titleTokens) === null)
    .map((track) => track.durationSeconds)
    .filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
  const kept: CandidateTrack[] = [];
  for (const track of pending) {
    if (isShort(track, policy, cohort)) removed.short_recording += 1;
    else kept.push(track);
  }
  if (kept.length === 0) return { outcome: "no_suitable_result", removed, reason: removalReason(removed) };
  const best = [...kept].sort((a, b) => compareSurvivors(a, b, policy))[0];
  if (!best) return { outcome: "no_suitable_result", removed, reason: removalReason(removed) };
  return { outcome: "selected", ...scoreTrack(best, input), removed };
}
