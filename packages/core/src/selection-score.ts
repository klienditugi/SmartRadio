/**
 * Deterministic, explainable pick among CandidateTrack values.
 * No provider types and no LLM. Same tracks and policy always return the same pick.
 *
 * Hard filters run once and are never relaxed. Survivors get a sum of named
 * components. Higher total wins. Ties break on peer username, then path.
 *
 * Priority, high to low. A higher item is not outweighed by the sum of the
 * realistic ranges below it. Hard filters remove a file before it can score.
 * Stems stay last unless the request asked for that part.
 *
 *  1. correct artist/title — title tokens are a hard filter
 *  2. explicit requested version
 *  3. saved version preference (basename, parent, clean original, and the fun-style second bonus)
 *  4. avoid bad results: long recording, short recording, a large duration overshoot,
 *     a stem, and a known bitrate under 128 kbps. Those files get no version bonus.
 *  5. audio quality (acceptable is enough; good is better, but both sit below version)
 *  6. saved format preference
 *  7. file-size soft preference when duration is known and normal
 *  8. peer availability
 *  9. username, then path
 *
 * Every scored tier clears the sum of the tiers below it. Known-duration size is
 * the exception at small ratios: the penalty is logarithmic, so a tiny size gap
 * does not beat a peer. Once the two files differ by 2.38×, the penalty
 * difference exceeds the normal peer span. The cap itself is larger than that
 * span and still strictly below the format gap, so format clears the worst
 * normal-duration size penalty plus a normal peer. Queues over 1000 (−60) are
 * an abandoned peer and are not part of the peer span.
 *
 * When the request names a version, the saved preference is off for every file,
 * including the fun-style second bonus. Rank on the requested-version match, then
 * the lower tiers. A hybrid such as "Radio Edit - X Remix" does not collect a
 * remix bonus on a radio-edit request.
 *
 * A mild duration overshoot (a 13-minute extended mix under the 20-minute hard cap)
 * still keeps the version bonus. The version steps clear that penalty plus quality,
 * format, size, and peer. The bonus stops when the overshoot reaches the duration
 * penalty cap, which is separate from the long-recording phrase penalty. Under
 * `extended`, a named remix gets the second bonus. Under `remix`, an extended or
 * club mix gets it. That second bonus clears the lower range and stays below a
 * parent-folder primary match.
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
  DEFAULT_PREFERRED_MAX_DURATION_SECONDS,
  DEFAULT_PREFERRED_MAX_FILE_SIZE_MB,
  DEFAULT_VERSION_PENALTY_TERMS,
  DEFAULT_VERSION_PREFERENCE,
  type FormatPreference,
  type VersionPreference,
} from "@subwave-ai/shared";
import type { CandidateTrack } from "./candidate.js";

const MIB = 1024 * 1024;

/**
 * Named component weights. Version and format preferences are the configurable
 * policy. Every other number is fixed.
 *
 * Equal-peer 6-minute files, default `prefer_mp3` / `extended`:
 * a 14 MiB 320 kbps MP3 scores quality 320 + format 112 when it is not the preferred style.
 * a 42 MiB 16/44.1 FLAC scores quality 320 + size −11. Format decides inside one style.
 * A preferred club or extended version outranks a radio edit or original of any fidelity.
 */
export const SCORE_WEIGHTS = {
  requestedVersion: 5800,
  /** Filename contains the title tokens. Path-only matches score `titleMatchPath`. */
  titleMatchBasename: 36,
  titleMatchPath: 8,
  artistInPath: 48,
  /**
   * Bonus for prefer_mp3 / prefer_flac. auto and the _only modes add 0.
   * Clears the known-duration size cap plus a normal peer. The _only modes are filters.
   */
  formatPreference: 112,
  /**
   * 256–320 kbps CBR, reported MP3 VBR at `bitrateVbrGoodMin` or higher, and in-cap
   * FLAC including hi-res. Hi-res gets no extra on top of this. VBR on other
   * formats, such as ogg, does not enter this tier.
   */
  qualityGood: 320,
  /** Lossy from the floor (default 192) up to 255, and MP3 VBR below `bitrateVbrGoodMin`. */
  qualityAcceptable: 80,
  /** Derived bitrate contributes this fraction of the reported lossy score, and no more. */
  qualityDerivedScale: 0.5,
  /**
   * Full penalty at 32 kbps. Below the floor the penalty is
   * −round(scale × fraction ^ power), where fraction is the distance from the
   * floor down to 32 kbps. Power below 1 drops faster than a straight line, so
   * 128 kbps against a 192 floor is −162 while 32 kbps is −256.
   */
  qualityLossyPenaltyScale: 256,
  qualityLossyPenaltyPower: 0.5,
  /**
   * Basename matches the saved version kind. Clears quality, format, known-duration
   * size, a normal peer, and a mild duration overshoot, and clears the parent step
   * by that same amount.
   */
  versionBasename: 3600,
  /**
   * Clean title (no version term) when the preference is original, and the parent is clean too.
   * Same height as the fun-style second bonus. Each clears the lower range on its own.
   */
  versionCleanOriginal: 1200,
  /**
   * Immediate parent folder only. Weaker than the basename and stronger than the
   * fun-style second bonus, each by more than quality + format + size + peer + a mild overshoot.
   */
  versionParent: 2400,
  /**
   * Under `extended`, a basename remix. Under `remix`, a basename extended or club mix.
   * Above radio edits and originals. Below a parent-folder primary match.
   * Not applied when the request itself names a version.
   */
  versionSecondary: 1200,
  /**
   * Known, normal duration: penalty is round(scale × ln(size / preferred)).
   * The difference between two files above the preferred size is about
   * scale × ln(big / small), so it does not depend on the preferred size.
   * At 32, a ratio of e^(27/32) ≈ 2.33× exceeds the normal peer span of 27
   * before rounding. On the scored curve, a 1.2× preferred file against
   * 2.38× that size is the first step that clears the span.
   */
  sizeGentleLogScale: 32,
  /**
   * Cap for that log curve. Larger than the peer span, strictly below the format
   * bonus, and high enough that a ~224 MiB file is still on the slope rather than
   * pinned to the same penalty as a ~71 MiB file.
   */
  sizeGentleCap: 72,
  /**
   * Points per 1.0 overshoot ratio when duration is unknown, the file is a long
   * recording, or duration is past the preferred max. That curve stands in for
   * the duration tier. It is not part of the size range under format preference.
   */
  sizeSteepPerRatio: 48,
  sizePenaltyCap: 140,
  /** Coefficient for duration overshoot. 15 min against a 12 min preferred max is −125. */
  durationPenaltyScale: 400,
  durationPenaltyCap: 400,
  /**
   * Duration overshoot at or below this drops the version bonus. Equal to the
   * duration penalty cap, not to `longRecording`, so a harsher long-phrase penalty
   * does not make every mild overshoot lose the bonus.
   */
  versionOvershootCutoff: -400,
  longRecording: -1000,
  /** Default ceiling for `shortRecording`. Config `short_recording_penalty` overrides it. */
  shortRecording: DEFAULT_SHORT_RECORDING_PENALTY,
  /** Larger than requestedVersion plus every positive component, so a stem stays last. */
  stem: -11200,
  availabilityFreeSlot: 6,
  availabilityNoSlot: -4,
  availabilityExtremeQueue: -60,
  availabilityExtremeQueueAbove: 1000,
  availabilityQueueStep: 25,
  availabilityQueueCap: 12,
  availabilitySpeedCap: 5,
  /** Known lossy bitrates are 32–320 inclusive. 321+ and anything outside 32–500 are unknown. */
  /** A known lossy rate below this gets no version-preference bonus. 128 itself still can. */
  bitrateVersionMin: 128,
  bitratePlausibleMin: 32,
  /** CBR, and any lossy file that is not a reported MP3 VBR, enters the good tier here. */
  bitrateGoodMin: 256,
  bitrateGoodMax: 320,
  /**
   * Reported MP3 VBR only (`track.vbr` from slskd `isVariableBitRate`, extension `.mp3`).
   * A missing flag is not VBR. The same flag on ogg or any other format does not
   * promote the file. CBR between this and `bitrateGoodMin` stays acceptable.
   */
  bitrateVbrGoodMin: 220,
  bitratePlausibleMax: 500,
} as const;

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

export type ScoreBreakdown = Record<ScoreComponent, number>;

export type QualitySignal = {
  /** `derived` is size/duration only, and only when no reported quality field was usable. */
  quality: "reported" | "derived" | "unknown";
  derivedBitrateKbps?: number;
};

export type TrackScore = {
  pick: CandidateTrack;
  breakdown: ScoreBreakdown;
  total: number;
  signals: QualitySignal;
};

/** Version terms that mean "this is not a full mix" rather than a desirable remix. */
const STEM_VERSION_TERMS = ["stem", "stems", "multitrack", "acapella", "a cappella", "acappella"] as const;

const TITLE_STOPWORDS = new Set(["a", "an", "the", "and", "of", "feat", "ft"]);

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
/** `<name> version` / `<name> edit` is a remix unless the name is one of these. */
const NAMED_EDIT_EXCLUSIONS = new Set(["radio", "single", "album", "original", "extended", "inch", "12"]);
const BARE_MIX_EXCEPTIONS = ["radio mix", "club mix", "original mix", "extended mix"] as const;

/** Removed from required title tokens so a requested version is a rank, not a filter. */
const TITLE_STRIP_PHRASES = [
  ...RADIO_EDIT_PHRASES,
  ...EXTENDED_PHRASES,
  ...ORIGINAL_PHRASES,
  ...OTHER_VERSION_PHRASES,
  ...REMIX_WORDS,
] as const;

/** Legacy request terms skipped once a version kind was recognized, so "radio edit" does not also mean every "edit". */
const CLASSIFIED_OVERLAP = new Set(["remix", "edit", "extended", "radio edit"]);

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
  /** Mebibytes. Omit for 200. `null` disables the cap. */
  maxFileSizeMb?: number | null;
  /** Seconds. Omit for 1200. `null` disables the hard cap. Missing duration stays eligible. */
  maxDurationSeconds?: number | null;
  /** Hz. Omit for 48000. `null` disables the cap. A missing sample rate stays eligible. */
  maxSampleRate?: number | null;
  /** Omit for 24. `null` disables the cap. A missing bit depth stays eligible. */
  maxBitDepth?: number | null;
  /** Mebibytes. Omit for 30. `null` disables the size penalty. */
  preferredMaxFileSizeMb?: number | null;
  /** Seconds. Omit for 720. `null` disables the duration penalty. */
  preferredMaxDurationSeconds?: number | null;
  /** Omit for `balanced`. Ranking bonus only. */
  versionPreference?: VersionPreference;
  /** Omit for `prefer_mp3`. `mp3_only` / `flac_only` filter after the extension allowlist. */
  formatPreference?: FormatPreference;
  /** kbps. Omit for 192. Lossy rates below this are penalized. */
  bitrateFloorKbps?: number;
  /** Fraction of the search median. Omit for 0.6. */
  shortRecordingFraction?: number;
  /** Known lengths required before the median fraction applies. Omit for 5. */
  shortRecordingMinSamples?: number;
  /** Seconds. Omit for 90. Known durations below this are short without a median. */
  shortRecordingFloorSeconds?: number;
  /** Most negative short-track score. Omit for −280. Zero disables it. */
  shortRecordingPenalty?: number;
  /**
   * Known durations of the correlated candidates in this search, including this file.
   * `selectTracks` fills this from the files that passed the hard filters.
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
  preferredMaxFileSizeMb: number | null;
  preferredMaxDurationSeconds: number | null;
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

function resolveNonNegative(value: number | null | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

export function resolveSelectionPolicy(input: SelectionPolicyInput = {}): ResolvedPolicy {
  return {
    allowedExtensions: input.allowedExtensions,
    minFileSizeMb: resolveOptionalCap(input.minFileSizeMb, DEFAULT_MIN_FILE_SIZE_MB),
    maxFileSizeMb: resolveOptionalCap(input.maxFileSizeMb, DEFAULT_MAX_FILE_SIZE_MB),
    maxDurationSeconds: resolveOptionalCap(input.maxDurationSeconds, DEFAULT_MAX_DURATION_SECONDS),
    maxSampleRate: resolveOptionalCap(input.maxSampleRate, DEFAULT_MAX_SAMPLE_RATE),
    maxBitDepth: resolveOptionalCap(input.maxBitDepth, DEFAULT_MAX_BIT_DEPTH),
    preferredMaxFileSizeMb: resolveOptionalCap(input.preferredMaxFileSizeMb, DEFAULT_PREFERRED_MAX_FILE_SIZE_MB),
    preferredMaxDurationSeconds: resolveOptionalCap(
      input.preferredMaxDurationSeconds,
      DEFAULT_PREFERRED_MAX_DURATION_SECONDS,
    ),
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

function parentText(track: CandidateTrack): string {
  const parent = track.folders[track.folders.length - 1];
  return parent ? normalizeMatchText(parent) : "";
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
  if (policy.maxFileSizeMb !== null && track.sizeBytes > policy.maxFileSizeMb * MIB) return "max_file_size";
  if (!withinHardDuration(track, policy.maxDurationSeconds)) return "max_duration";
  if (policy.maxSampleRate !== null && track.sampleRateHz !== undefined && track.sampleRateHz > policy.maxSampleRate) {
    return "max_sample_rate";
  }
  if (policy.maxBitDepth !== null && track.bitDepth !== undefined && track.bitDepth > policy.maxBitDepth) {
    return "max_bit_depth";
  }
  if (titleTokens && !hasEveryToken(pathText(track), titleTokens)) return "title_mismatch";
  return null;
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

/**
 * Version marks on already-normalized text.
 * radio edit / single edit win as radio_edit, not as a named remix.
 * "extended mix" and "club mix" are extended, not remixes, and not long recordings.
 * A bare "mix" is not a remix and is not a clean title.
 * `<name> remix`, `rmx`, and `<name> version` / `<name> edit` are remixes when the
 * name is not radio, single, album, original, or extended.
 */
export function classifyVersionText(text: string): VersionMarks {
  const radio_edit = hasAnyPhrase(text, RADIO_EDIT_PHRASES);
  const extended = hasAnyPhrase(text, EXTENDED_PHRASES);
  const original = hasAnyPhrase(text, ORIGINAL_PHRASES);
  const remixWord = hasAnyPhrase(text, REMIX_WORDS);
  const tokens = text ? text.split(" ") : [];
  let named = false;
  for (let i = 0; i < tokens.length - 1; i++) {
    const name = tokens[i] ?? "";
    const next = tokens[i + 1];
    if (next !== "version" && next !== "edit") continue;
    if (!name || NAMED_EDIT_EXCLUSIONS.has(name) || /^\d+$/.test(name)) continue;
    named = true;
    break;
  }
  const remix = remixWord || named;
  const bareMix = hasPhrase(text, "mix") && !hasAnyPhrase(text, BARE_MIX_EXCEPTIONS);
  const danglingEdit = hasPhrase(text, "edit") && !radio_edit && !remix && !original && !extended;
  const other = hasAnyPhrase(text, OTHER_VERSION_PHRASES) || bareMix || danglingEdit;
  return { radio_edit, extended, remix, original, other };
}

function isCleanTitle(marks: VersionMarks): boolean {
  return !marks.radio_edit && !marks.extended && !marks.remix && !marks.original && !marks.other;
}

function marksMatch(marks: VersionMarks, preference: VersionPreference): boolean {
  if (preference === "balanced") return false;
  return marks[preference];
}

function knownLossy(kbps: number): boolean {
  return kbps >= SCORE_WEIGHTS.bitratePlausibleMin && kbps <= SCORE_WEIGHTS.bitrateGoodMax;
}

function lossyPoints(kbps: number, floor: number, vbr: boolean | undefined, ext: string): number {
  const inRange = kbps <= SCORE_WEIGHTS.bitrateGoodMax;
  const cbrGood = kbps >= SCORE_WEIGHTS.bitrateGoodMin && inRange;
  const vbrGood = ext === ".mp3" && vbr === true && kbps >= SCORE_WEIGHTS.bitrateVbrGoodMin && inRange;
  if (cbrGood || vbrGood) return SCORE_WEIGHTS.qualityGood;
  if (kbps >= floor) return SCORE_WEIGHTS.qualityAcceptable;
  const span = Math.max(1, floor - SCORE_WEIGHTS.bitratePlausibleMin);
  const fraction = (floor - kbps) / span;
  const shaped = Math.pow(fraction, SCORE_WEIGHTS.qualityLossyPenaltyPower);
  return -Math.round(shaped * SCORE_WEIGHTS.qualityLossyPenaltyScale);
}

function qualityOf(track: CandidateTrack, floor: number): { points: number; signal: QualitySignal } {
  if (track.format.lossless) {
    const depth = track.bitDepth;
    const rate = track.sampleRateHz;
    if (depth === undefined && rate === undefined) return { points: 0, signal: { quality: "unknown" } };
    const hiRes = (depth !== undefined && depth > 16) || (rate !== undefined && rate > 48_000);
    const standardDepth = depth === undefined || depth === 16;
    const standardRate = rate === undefined || rate === 44_100 || rate === 48_000;
    if (hiRes || (standardDepth && standardRate)) {
      return { points: SCORE_WEIGHTS.qualityGood, signal: { quality: "reported" } };
    }
    return { points: 0, signal: { quality: "reported" } };
  }

  if (track.bitrateKbps !== undefined) {
    if (!knownLossy(track.bitrateKbps)) return { points: 0, signal: { quality: "unknown" } };
    return { points: lossyPoints(track.bitrateKbps, floor, track.vbr, track.format.ext), signal: { quality: "reported" } };
  }
  if (track.durationSeconds !== undefined && track.durationSeconds > 0 && track.sizeBytes > 0) {
    const derived = (track.sizeBytes * 8) / track.durationSeconds / 1000;
    const derivedBitrateKbps = Math.round(derived);
    if (knownLossy(derived)) {
      return {
        // No reported bitrate, so the VBR flag cannot promote this into the good tier.
        points: Math.round(lossyPoints(derived, floor, undefined, track.format.ext) * SCORE_WEIGHTS.qualityDerivedScale),
        signal: { quality: "derived", derivedBitrateKbps },
      };
    }
    return { points: 0, signal: { quality: "derived", derivedBitrateKbps } };
  }
  return { points: 0, signal: { quality: "unknown" } };
}

/**
 * Cap for a known, non-long, non-overshooting duration. Strictly below the
 * format bonus. The log curve reaches this only for a very large file; a
 * moderate overshoot stays on the slope.
 */
function knownDurationSizeCap(): number {
  const formatGap = SCORE_WEIGHTS.formatPreference;
  if (formatGap <= 1) return 0;
  return Math.min(SCORE_WEIGHTS.sizeGentleCap, formatGap - 1);
}

/** Unknown duration, a long-recording phrase, or a duration past the preferred max. */
function sizeStandsInForDuration(track: CandidateTrack, policy: ResolvedPolicy): boolean {
  if (track.durationSeconds === undefined) return true;
  if (matchesLongRecording(track, policy.longRecordingPhrases)) return true;
  if (policy.preferredMaxDurationSeconds !== null && track.durationSeconds > policy.preferredMaxDurationSeconds) {
    return true;
  }
  return false;
}

function sizeOvershoot(track: CandidateTrack, policy: ResolvedPolicy): number {
  if (policy.preferredMaxFileSizeMb === null) return 0;
  const sizeMb = track.sizeBytes / MIB;
  if (sizeMb <= policy.preferredMaxFileSizeMb) return 0;
  const ratio = (sizeMb - policy.preferredMaxFileSizeMb) / policy.preferredMaxFileSizeMb;
  if (!sizeStandsInForDuration(track, policy)) {
    const penalty = Math.round(SCORE_WEIGHTS.sizeGentleLogScale * Math.log(1 + ratio));
    return -Math.min(knownDurationSizeCap(), Math.max(0, penalty));
  }
  const penalty = Math.round(SCORE_WEIGHTS.sizeSteepPerRatio * ratio);
  return -Math.min(SCORE_WEIGHTS.sizePenaltyCap, penalty);
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1] ?? upper;
  return (lower + upper) / 2;
}

/**
 * Soft penalty for a known short duration. Missing duration is not short.
 * The line is the absolute floor, or (when enough lengths are known) the
 * fraction of the median, whichever is higher and still above this file.
 * The score scales from 0 at that line to `shortRecordingPenalty` at 0 seconds.
 */
function shortRecordingPoints(track: CandidateTrack, policy: ResolvedPolicy, cohort: readonly number[]): number {
  const duration = track.durationSeconds;
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) return 0;
  let line = 0;
  if (duration < policy.shortRecordingFloorSeconds) line = policy.shortRecordingFloorSeconds;
  const known = cohort.filter((value) => Number.isFinite(value) && value > 0);
  if (known.length >= policy.shortRecordingMinSamples) {
    const relative = policy.shortRecordingFraction * medianOf(known);
    if (duration < relative) line = Math.max(line, relative);
  }
  if (!(line > duration)) return 0;
  const ratio = (line - duration) / line;
  const magnitude = Math.abs(policy.shortRecordingPenalty);
  return -Math.min(magnitude, Math.round(magnitude * ratio));
}

function durationOvershoot(track: CandidateTrack, policy: ResolvedPolicy): number {
  if (policy.preferredMaxDurationSeconds === null) return 0;
  if (track.durationSeconds === undefined) return 0;
  if (track.durationSeconds <= policy.preferredMaxDurationSeconds) return 0;
  const overRatio = (track.durationSeconds - policy.preferredMaxDurationSeconds) / policy.preferredMaxDurationSeconds;
  const penalty = Math.round(SCORE_WEIGHTS.durationPenaltyScale * overRatio * (1 + overRatio));
  return -Math.min(SCORE_WEIGHTS.durationPenaltyCap, penalty);
}

function reportedOrDerivedKbps(track: CandidateTrack): number | undefined {
  if (track.format.lossless) return undefined;
  if (track.bitrateKbps !== undefined && knownLossy(track.bitrateKbps)) return track.bitrateKbps;
  if (track.durationSeconds !== undefined && track.durationSeconds > 0 && track.sizeBytes > 0) {
    const derived = Math.round((track.sizeBytes * 8) / track.durationSeconds / 1000);
    if (knownLossy(derived)) return derived;
  }
  return undefined;
}

/**
 * Bad results get no saved-version bonus. A mild duration overshoot still can:
 * the file keeps the bonus until the overshoot reaches `versionOvershootCutoff`.
 */
function versionBonusBlocked(
  track: CandidateTrack,
  policy: ResolvedPolicy,
  cohort: readonly number[],
  stem: boolean,
): boolean {
  if (stem) return true;
  if (matchesLongRecording(track, policy.longRecordingPhrases)) return true;
  if (shortRecordingPoints(track, policy, cohort) < 0) return true;
  const kbps = reportedOrDerivedKbps(track);
  if (kbps !== undefined && kbps < SCORE_WEIGHTS.bitrateVersionMin) return true;
  if (durationOvershoot(track, policy) <= SCORE_WEIGHTS.versionOvershootCutoff) return true;
  return false;
}

/** The request names a version kind or a version-penalty term, so the saved preference stays off. */
function requestNamesVersion(policy: ResolvedPolicy): boolean {
  const askedText = requestedBlob(policy.query);
  if (!askedText) return false;
  const asked = classifyVersionText(askedText);
  if (asked.radio_edit || asked.extended || asked.remix || asked.original || asked.other) return true;
  return matchedTerms(askedText, policy.versionPenaltyTerms).length > 0;
}

function availabilityScore(track: CandidateTrack): number {
  const slot = track.availability?.freeSlot;
  const queue = track.availability?.queueLength;
  const speed = track.availability?.speedBps;
  let score = 0;
  if (slot === true) score += SCORE_WEIGHTS.availabilityFreeSlot;
  else if (slot === false) score -= Math.abs(SCORE_WEIGHTS.availabilityNoSlot);
  if (queue !== undefined && Number.isFinite(queue) && queue > 0) {
    if (queue > SCORE_WEIGHTS.availabilityExtremeQueueAbove) score += SCORE_WEIGHTS.availabilityExtremeQueue;
    else score -= Math.min(SCORE_WEIGHTS.availabilityQueueCap, Math.ceil(queue / SCORE_WEIGHTS.availabilityQueueStep));
  }
  if (speed !== undefined && Number.isFinite(speed) && speed > 1) {
    const bonus = Math.round(Math.log10(speed) - 2);
    score += Math.max(0, Math.min(SCORE_WEIGHTS.availabilitySpeedCap, bonus));
  }
  return score;
}

function versionPreferencePoints(
  track: CandidateTrack,
  policy: ResolvedPolicy,
  cohort: readonly number[],
  stem: boolean,
): number {
  if (policy.versionPreference === "balanced") return 0;
  if (requestNamesVersion(policy)) return 0;
  if (versionBonusBlocked(track, policy, cohort, stem)) return 0;
  const base = classifyVersionText(basenameText(track));
  const parent = classifyVersionText(parentText(track));
  const preference = policy.versionPreference;
  if (marksMatch(base, preference)) return SCORE_WEIGHTS.versionBasename;
  if (preference === "original" && isCleanTitle(base) && isCleanTitle(parent)) return SCORE_WEIGHTS.versionCleanOriginal;
  if (marksMatch(parent, preference)) return SCORE_WEIGHTS.versionParent;
  if (preference === "extended" && base.remix) return SCORE_WEIGHTS.versionSecondary;
  if (preference === "remix" && base.extended) return SCORE_WEIGHTS.versionSecondary;
  return 0;
}

function explicitRequestMatches(fileText: string, policy: ResolvedPolicy): boolean {
  const askedText = requestedBlob(policy.query);
  if (!askedText) return false;
  const asked = classifyVersionText(askedText);
  const file = classifyVersionText(fileText);
  if (asked.radio_edit && file.radio_edit) return true;
  if (asked.extended && file.extended) return true;
  if (asked.remix && file.remix) return true;
  if (asked.original && file.original) return true;
  const classified = asked.radio_edit || asked.extended || asked.remix || asked.original;
  const terms = classified
    ? policy.versionPenaltyTerms.filter((term) => !CLASSIFIED_OVERLAP.has(term.toLowerCase()))
    : policy.versionPenaltyTerms;
  const askedTerms = matchedTerms(askedText, terms);
  const fileTerms = matchedTerms(fileText, terms);
  return askedTerms.some((term) => fileTerms.some((found) => sameTerm(found, term)));
}

function formatPoints(track: CandidateTrack, preference: FormatPreference): number {
  if (preference === "prefer_mp3" && track.format.ext === ".mp3") return SCORE_WEIGHTS.formatPreference;
  if (preference === "prefer_flac" && track.format.ext === ".flac") return SCORE_WEIGHTS.formatPreference;
  return 0;
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

export function scoreTrack(track: CandidateTrack, input: SelectionPolicyInput = {}): TrackScore {
  const policy = resolveSelectionPolicy(input);
  const titleTokens = requiredTitleTokens(policy.query, policy.versionPenaltyTerms);
  const artists = artistTokenList(policy.query);
  const askedText = requestedBlob(policy.query);
  const fileText = pathText(track);
  const asked = matchedTerms(askedText, policy.versionPenaltyTerms);
  const breakdown = emptyBreakdown();

  if (explicitRequestMatches(fileText, policy)) breakdown.requestedVersion = SCORE_WEIGHTS.requestedVersion;
  if (titleTokens && titleTokens.length > 0) {
    breakdown.titleMatch = hasEveryToken(basenameText(track), titleTokens)
      ? SCORE_WEIGHTS.titleMatchBasename
      : SCORE_WEIGHTS.titleMatchPath;
  }
  if (artists.length > 0 && hasEveryToken(fileText, artists)) breakdown.artistInPath = SCORE_WEIGHTS.artistInPath;
  breakdown.format = formatPoints(track, policy.formatPreference);

  const quality = qualityOf(track, policy.bitrateFloorKbps);
  breakdown.quality = quality.points;
  const cohort = input.cohortDurationSeconds ?? [];
  const stem = incidentalStem(track, policy, titleTokens, asked);
  breakdown.versionPreference = versionPreferencePoints(track, policy, cohort, stem);
  breakdown.sizeOvershoot = sizeOvershoot(track, policy);
  breakdown.durationOvershoot = durationOvershoot(track, policy);
  if (matchesLongRecording(track, policy.longRecordingPhrases)) breakdown.longRecording = SCORE_WEIGHTS.longRecording;
  breakdown.shortRecording = shortRecordingPoints(track, policy, cohort);
  if (stem) breakdown.stem = SCORE_WEIGHTS.stem;
  breakdown.availability = availabilityScore(track);

  const total = SCORE_COMPONENTS.reduce((sum, key) => sum + breakdown[key], 0);
  return { pick: track, breakdown, total, signals: quality.signal };
}

function compareScored(a: TrackScore, b: TrackScore): number {
  if (a.total !== b.total) return b.total - a.total;
  const peer = a.pick.peer.localeCompare(b.pick.peer);
  if (peer !== 0) return peer;
  return a.pick.path.localeCompare(b.pick.path);
}

/**
 * Filter, score, and pick. Filters are not relaxed when every track is removed.
 */
export function selectTracks(tracks: readonly CandidateTrack[], input: SelectionPolicyInput = {}): TrackSelection {
  const policy = resolveSelectionPolicy(input);
  const titleTokens = requiredTitleTokens(policy.query, policy.versionPenaltyTerms);
  const removed = emptyRemovals();
  const kept: CandidateTrack[] = [];
  for (const track of tracks) {
    const rejection = firstRejection(track, policy, titleTokens);
    if (rejection) removed[rejection] += 1;
    else kept.push(track);
  }
  if (kept.length === 0) return { outcome: "no_suitable_result", removed, reason: removalReason(removed) };
  const cohortDurationSeconds = kept
    .map((track) => track.durationSeconds)
    .filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
  const scored = kept.map((track) => scoreTrack(track, { ...input, cohortDurationSeconds }));
  scored.sort(compareScored);
  const best = scored[0];
  if (!best) return { outcome: "no_suitable_result", removed, reason: removalReason(removed) };
  return { outcome: "selected", ...best, removed };
}
