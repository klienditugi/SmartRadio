/**
 * Deterministic, explainable pick among CandidateTrack values.
 * No provider types and no LLM. Same tracks and policy always return the same pick.
 *
 * Hard filters run once and are never relaxed. Survivors get a sum of named
 * components. Higher total wins. Ties break on peer, then path.
 *
 * Default weights (SCORE_WEIGHTS) are the documented policy. `losslessPreference`
 * is the one weight the config overrides, so a normal-duration 16/44.1 FLAC can
 * be ranked above or below a 320 kbps MP3 without retuning the rest.
 */

import {
  DEFAULT_BITRATE_FLOOR_KBPS,
  DEFAULT_EXTENDED_VERSION_BONUS,
  DEFAULT_EXTENDED_VERSION_TERMS,
  DEFAULT_INSTRUMENT_PART_BASENAMES,
  DEFAULT_LONG_RECORDING_PHRASES,
  DEFAULT_LOSSLESS_PREFERENCE,
  DEFAULT_MAX_BIT_DEPTH,
  DEFAULT_MAX_DURATION_SECONDS,
  DEFAULT_MAX_FILE_SIZE_MB,
  DEFAULT_MAX_SAMPLE_RATE,
  DEFAULT_MIN_FILE_SIZE_MB,
  DEFAULT_PREFERRED_MAX_DURATION_SECONDS,
  DEFAULT_PREFERRED_MAX_FILE_SIZE_MB,
  DEFAULT_VERSION_PENALTY_TERMS,
} from "@subwave-ai/shared";
import type { CandidateTrack } from "./candidate.js";

const MIB = 1024 * 1024;

/**
 * Named component weights. `losslessPreference` is the default; a policy may
 * replace it. Every other number is fixed.
 *
 * Format balance at these defaults, both files ~6 min, same peer:
 * a 42 MiB 16/44.1 FLAC scores format 36 + quality 30 + size overshoot -5 = 61.
 * a 14 MiB 320 kbps MP3 scores quality 28. The FLAC wins.
 * With losslessPreference 0 the FLAC scores 25 and the MP3 wins.
 */
export const SCORE_WEIGHTS = {
  requestedVersion: 1000,
  titleMatchBasename: 12,
  titleMatchPath: 4,
  artistInPath: 24,
  losslessPreference: DEFAULT_LOSSLESS_PREFERENCE,
  qualityLosslessGood: 30,
  qualityLosslessHigher: 8,
  qualityLossyReward: 28,
  qualityLossyStrong: 22,
  qualityLossyAtFloor: 8,
  qualityLossyPenaltyScale: 48,
  /** Derived bitrate contributes this fraction of the reported lossy score. */
  qualityDerivedScale: 0.5,
  extendedBonus: 48,
  /** Points per 1.0 overshoot ratio while duration is known and normal, up to 1.0. */
  sizeGentlePerRatio: 12,
  /** Points per 1.0 overshoot ratio when duration is unknown, the file is long, or the ratio exceeds 1. */
  sizeSteepPerRatio: 48,
  sizeGentleRatioLimit: 1,
  sizePenaltyCap: 140,
  /** Coefficient for duration overshoot. 15 min against a 12 min preferred max is -125. */
  durationPenaltyScale: 400,
  durationPenaltyCap: 400,
  longRecording: -280,
  /** Larger than requestedVersion plus every positive component, so a stem stays last. */
  stem: -1600,
  availabilityFreeSlot: 6,
  availabilityNoSlot: -4,
  availabilityExtremeQueue: -60,
  availabilityExtremeQueueAbove: 1000,
  availabilityQueueStep: 25,
  availabilityQueueCap: 12,
  availabilitySpeedCap: 5,
  /** Lossy bitrates outside this closed range are unknown, never a quality guess. */
  bitratePlausibleMin: 32,
  bitratePlausibleMax: 500,
} as const;

export const SCORE_COMPONENTS = [
  "requestedVersion",
  "titleMatch",
  "artistInPath",
  "format",
  "quality",
  "extendedBonus",
  "sizeOvershoot",
  "durationOvershoot",
  "longRecording",
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
  /** Omit for on. Applied only when the length is normal. */
  extendedVersionBonus?: boolean;
  /** Format weight for a lossless file. Omit for 36. 0 lets a 320 kbps MP3 beat a 42 MiB 16/44.1 FLAC. */
  losslessPreference?: number;
  /** kbps. Omit for 192. Lossy rates below this are penalized. */
  bitrateFloorKbps?: number;
  versionPenaltyTerms?: readonly string[];
  instrumentPartBasenames?: readonly string[];
  extendedVersionTerms?: readonly string[];
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
  extendedVersionBonus: boolean;
  losslessPreference: number;
  bitrateFloorKbps: number;
  versionPenaltyTerms: readonly string[];
  instrumentPartBasenames: readonly string[];
  extendedVersionTerms: readonly string[];
  longRecordingPhrases: readonly string[];
  query: SelectionQuery;
};

export type TrackSelection =
  | ({ outcome: "selected" } & TrackScore)
  | { outcome: "no_suitable_result"; removed: FilterRemovalCounts; reason: string };

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
    extendedVersionBonus: input.extendedVersionBonus ?? DEFAULT_EXTENDED_VERSION_BONUS,
    losslessPreference: resolveNonNegative(input.losslessPreference, DEFAULT_LOSSLESS_PREFERENCE),
    bitrateFloorKbps: resolveOptionalCap(input.bitrateFloorKbps, DEFAULT_BITRATE_FLOOR_KBPS) ?? DEFAULT_BITRATE_FLOOR_KBPS,
    versionPenaltyTerms: input.versionPenaltyTerms ?? DEFAULT_VERSION_PENALTY_TERMS,
    instrumentPartBasenames: input.instrumentPartBasenames ?? DEFAULT_INSTRUMENT_PART_BASENAMES,
    extendedVersionTerms: input.extendedVersionTerms ?? DEFAULT_EXTENDED_VERSION_TERMS,
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
    extendedBonus: 0,
    sizeOvershoot: 0,
    durationOvershoot: 0,
    longRecording: 0,
    stem: 0,
    availability: 0,
  };
}

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
  const tokens = significantTokens(stripVersionTerms(normalizeMatchText(dropBracketedCredits(title)), terms));
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

function lossyPoints(kbps: number, floor: number): number {
  if (kbps >= 256 && kbps <= 320) return SCORE_WEIGHTS.qualityLossyReward;
  if (kbps > 320 && kbps <= SCORE_WEIGHTS.bitratePlausibleMax) return SCORE_WEIGHTS.qualityLossyStrong;
  if (kbps >= floor) return SCORE_WEIGHTS.qualityLossyAtFloor;
  const span = Math.max(1, floor - SCORE_WEIGHTS.bitratePlausibleMin);
  return -Math.round(((floor - kbps) / span) * SCORE_WEIGHTS.qualityLossyPenaltyScale);
}

function qualityOf(track: CandidateTrack, floor: number): { points: number; signal: QualitySignal } {
  if (track.format.lossless) {
    const depth = track.bitDepth;
    const rate = track.sampleRateHz;
    if (depth === undefined && rate === undefined) return { points: 0, signal: { quality: "unknown" } };
    const higher = (depth !== undefined && depth > 16) || (rate !== undefined && rate > 48_000);
    const goodDepth = depth === undefined || depth === 16;
    const goodRate = rate === undefined || rate === 44_100 || rate === 48_000;
    if (higher) {
      return {
        points: SCORE_WEIGHTS.qualityLosslessGood + SCORE_WEIGHTS.qualityLosslessHigher,
        signal: { quality: "reported" },
      };
    }
    if (goodDepth && goodRate) {
      return { points: SCORE_WEIGHTS.qualityLosslessGood, signal: { quality: "reported" } };
    }
    return { points: 0, signal: { quality: "reported" } };
  }

  if (track.bitrateKbps !== undefined) {
    return { points: lossyPoints(track.bitrateKbps, floor), signal: { quality: "reported" } };
  }
  if (track.durationSeconds !== undefined && track.durationSeconds > 0 && track.sizeBytes > 0) {
    const derived = (track.sizeBytes * 8) / track.durationSeconds / 1000;
    const derivedBitrateKbps = Math.round(derived);
    if (derived >= SCORE_WEIGHTS.bitratePlausibleMin && derived <= SCORE_WEIGHTS.bitratePlausibleMax) {
      return {
        points: Math.round(lossyPoints(derived, floor) * SCORE_WEIGHTS.qualityDerivedScale),
        signal: { quality: "derived", derivedBitrateKbps },
      };
    }
    return { points: 0, signal: { quality: "derived", derivedBitrateKbps } };
  }
  return { points: 0, signal: { quality: "unknown" } };
}

function sizeOvershoot(track: CandidateTrack, policy: ResolvedPolicy): number {
  if (policy.preferredMaxFileSizeMb === null) return 0;
  const sizeMb = track.sizeBytes / MIB;
  if (sizeMb <= policy.preferredMaxFileSizeMb) return 0;
  const ratio = (sizeMb - policy.preferredMaxFileSizeMb) / policy.preferredMaxFileSizeMb;
  const normalDuration =
    policy.preferredMaxDurationSeconds !== null &&
    track.durationSeconds !== undefined &&
    track.durationSeconds <= policy.preferredMaxDurationSeconds;
  let penalty: number;
  if (normalDuration && ratio <= SCORE_WEIGHTS.sizeGentleRatioLimit) {
    penalty = SCORE_WEIGHTS.sizeGentlePerRatio * ratio;
  } else if (normalDuration) {
    const extra = ratio - SCORE_WEIGHTS.sizeGentleRatioLimit;
    penalty = SCORE_WEIGHTS.sizeGentlePerRatio * SCORE_WEIGHTS.sizeGentleRatioLimit + SCORE_WEIGHTS.sizeSteepPerRatio * extra;
  } else {
    penalty = SCORE_WEIGHTS.sizeSteepPerRatio * ratio;
  }
  return -Math.min(SCORE_WEIGHTS.sizePenaltyCap, Math.round(penalty));
}

function durationOvershoot(track: CandidateTrack, policy: ResolvedPolicy): number {
  if (policy.preferredMaxDurationSeconds === null) return 0;
  if (track.durationSeconds === undefined) return 0;
  if (track.durationSeconds <= policy.preferredMaxDurationSeconds) return 0;
  const overRatio = (track.durationSeconds - policy.preferredMaxDurationSeconds) / policy.preferredMaxDurationSeconds;
  const penalty = Math.round(SCORE_WEIGHTS.durationPenaltyScale * overRatio * (1 + overRatio));
  return -Math.min(SCORE_WEIGHTS.durationPenaltyCap, penalty);
}

function lengthIsNormal(track: CandidateTrack, policy: ResolvedPolicy): boolean {
  if (track.durationSeconds !== undefined && policy.preferredMaxDurationSeconds !== null) {
    return track.durationSeconds <= policy.preferredMaxDurationSeconds;
  }
  if (matchesLongRecording(track, policy.longRecordingPhrases)) return false;
  if (policy.preferredMaxFileSizeMb === null) return true;
  return track.sizeBytes / MIB <= policy.preferredMaxFileSizeMb;
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
  const fileTerms = matchedTerms(fileText, policy.versionPenaltyTerms);
  const requested = asked.some((term) => fileTerms.some((found) => sameTerm(found, term)));
  const breakdown = emptyBreakdown();

  if (requested) breakdown.requestedVersion = SCORE_WEIGHTS.requestedVersion;
  if (titleTokens && titleTokens.length > 0) {
    breakdown.titleMatch = hasEveryToken(basenameText(track), titleTokens)
      ? SCORE_WEIGHTS.titleMatchBasename
      : SCORE_WEIGHTS.titleMatchPath;
  }
  if (artists.length > 0 && hasEveryToken(fileText, artists)) breakdown.artistInPath = SCORE_WEIGHTS.artistInPath;
  if (track.format.lossless) breakdown.format = Math.round(policy.losslessPreference);

  const quality = qualityOf(track, policy.bitrateFloorKbps);
  breakdown.quality = quality.points;

  const extended = matchedTerms(fileText, policy.extendedVersionTerms).length > 0;
  if (policy.extendedVersionBonus && extended && lengthIsNormal(track, policy)) {
    breakdown.extendedBonus = SCORE_WEIGHTS.extendedBonus;
  }
  breakdown.sizeOvershoot = sizeOvershoot(track, policy);
  breakdown.durationOvershoot = durationOvershoot(track, policy);
  if (matchesLongRecording(track, policy.longRecordingPhrases)) breakdown.longRecording = SCORE_WEIGHTS.longRecording;
  if (incidentalStem(track, policy, titleTokens, asked)) breakdown.stem = SCORE_WEIGHTS.stem;
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
  const scored = kept.map((track) => scoreTrack(track, input));
  scored.sort(compareScored);
  const best = scored[0];
  if (!best) return { outcome: "no_suitable_result", removed, reason: removalReason(removed) };
  return { outcome: "selected", ...best };
}
