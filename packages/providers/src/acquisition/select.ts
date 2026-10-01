/**
 * slskd search adapter. Maps search JSON into CandidateTrack and asks the
 * provider-neutral scorer to pick. This file does not rank and does not call an LLM.
 *
 * Accepted payload shapes, all equivalent:
 * - a search object with `responses`
 * - `{ responses: [...] }`
 * - a bare array of responses
 *
 * `lockedFiles` are mapped as locked candidates. They are filtered and counted, never chosen,
 * and never used as a fallback pool. `length` is duration in seconds, never bytes.
 * An empty or junk `extension` falls back to the filename.
 *
 * Hard filters are exclusions and are not relaxed. See `selectTracks`.
 */

import {
  removalReason,
  selectTracks,
  type CandidateTrack,
  type FilterRemovalCounts,
  type QualitySignal,
  type ScoreBreakdown,
  type SelectionPolicyInput,
  type TrackScore,
} from "@subwave-ai/core";

export type { FilterRemovalCounts, QualitySignal, ScoreBreakdown };
export { removalReason };

export type SelectedSearchFile = {
  username: string;
  filename: string;
  size: number;
  /** Copied when the payload has one. Not used for scoring or transfer correlation. */
  responseId?: string;
  /** Copied when the payload has one. Not a transfer id. */
  fileId?: string;
  extension?: string;
  /** Raw reported bitRate, including values the scorer treats as unknown. */
  bitRate?: number;
  /**
   * Search `length` in seconds, when the payload has one.
   * Copied for later checks. Not used for ranking.
   */
  durationSeconds?: number;
};

/** Artist/title text. Version terms in the title change the score, not eligibility. */
export type SelectSearchQuery = {
  artist?: string;
  title?: string;
  /** Extra request text, treated like artist/title for a requested version. */
  text?: string;
};

export type SelectSearchOptions = SelectionPolicyInput & {
  query?: SelectSearchQuery;
  context?: SelectSearchQuery;
};

export type SearchSelection =
  | ({
      outcome: "selected";
      file: SelectedSearchFile;
      removed: FilterRemovalCounts;
    } & TrackScore)
  | { outcome: "no_responses" }
  | { outcome: "no_usable_candidate" }
  | { outcome: "no_suitable_result"; removed: FilterRemovalCounts; reason: string };

const LOSSLESS_EXTENSIONS = new Set([".flac", ".wav"]);

type MappedFile = {
  track: CandidateTrack;
  responseId?: string;
  fileId?: string;
  rawBitRate?: number;
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

function lockedFilesFrom(response: Record<string, unknown>): unknown[] {
  if (Array.isArray(response.lockedFiles)) return response.lockedFiles;
  if (Array.isArray(response.LockedFiles)) return response.LockedFiles;
  return [];
}

/**
 * A usable extension is a short alphanumeric token, with or without a leading dot.
 * `flac@synoeastream` and other junk fall through to the filename.
 */
function usableExtension(raw: string): string | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  const withDot = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  if (!/^\.[a-z0-9]{1,5}$/.test(withDot)) return undefined;
  return withDot;
}

function resolveExtension(raw: unknown, filename: string): string {
  const fromField = typeof raw === "string" ? usableExtension(raw) : undefined;
  return fromField ?? usableExtension(extensionOf(filename)) ?? "";
}

function pathParts(filename: string): { basename: string; folders: string[] } {
  const parts = filename.split(/[/\\]/).filter((part) => part.length > 0);
  if (parts.length === 0) return { basename: filename, folders: [] };
  const basename = parts[parts.length - 1] ?? filename;
  return { basename, folders: parts.slice(0, -1) };
}

function slotFlag(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

function locked(file: Record<string, unknown>): boolean {
  return file.isLocked === true || file.IsLocked === true;
}


function collect(payload: unknown): MappedFile[] {
  const out: MappedFile[] = [];
  for (const raw of responsesFrom(payload)) {
    const response = asRecord(raw);
    if (!response) continue;
    const peer = str(response.username) ?? str(response.user);
    if (!peer) continue;
    const responseId = idStr(response.id) ?? idStr(response.responseId);
    const freeSlot = slotFlag(response.hasFreeUploadSlot ?? response.HasFreeUploadSlot);
    const queueLength = num(response.queueLength ?? response.QueueLength);
    const speedBps = num(response.uploadSpeed ?? response.UploadSpeed);
    const pushFile = (rawFile: unknown, forceLocked: boolean) => {
      const file = asRecord(rawFile);
      if (!file) return;
      const path = str(file.filename) ?? str(file.fileName) ?? str(file.name);
      const sizeBytes = num(file.size) ?? num(file.bytes) ?? num(file.Size);
      if (!path || sizeBytes === undefined || sizeBytes <= 0) return;
      const ext = resolveExtension(file.extension ?? file.Extension, path);
      const { basename, folders } = pathParts(path);
      const rawBitRate = num(file.bitRate) ?? num(file.bitrate) ?? num(file.BitRate);
      const lossless = LOSSLESS_EXTENSIONS.has(ext);
      // Pass the reported number through, including junk. The scorer decides unknown vs usable.
      // A lossless file is scored from bit depth and sample rate, never from bitRate.
      const bitrateKbps = lossless ? undefined : rawBitRate;
      const sampleRateHz = num(file.sampleRate) ?? num(file.SampleRate);
      const bitDepth = num(file.bitDepth) ?? num(file.BitDepth);
      const length = num(file.length);
      const durationSeconds = length !== undefined && length > 0 ? length : undefined;
      const vbrFlag = file.isVariableBitRate ?? file.IsVariableBitRate;
      const availability =
        freeSlot !== undefined || queueLength !== undefined || speedBps !== undefined
          ? {
              ...(freeSlot !== undefined ? { freeSlot } : {}),
              ...(queueLength !== undefined ? { queueLength } : {}),
              ...(speedBps !== undefined ? { speedBps } : {}),
            }
          : undefined;
      const track: CandidateTrack = {
        peer,
        path,
        basename,
        folders,
        sizeBytes,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        format: { ext, lossless },
        ...(bitrateKbps !== undefined ? { bitrateKbps } : {}),
        ...(sampleRateHz !== undefined ? { sampleRateHz } : {}),
        ...(bitDepth !== undefined ? { bitDepth } : {}),
        ...(vbrFlag === true || vbrFlag === false ? { vbr: vbrFlag } : {}),
        ...(availability ? { availability } : {}),
        locked: forceLocked || locked(file),
      };
      out.push({
        track,
        ...(responseId ? { responseId } : {}),
        ...(idStr(file.id) ?? idStr(file.fileId) ? { fileId: idStr(file.id) ?? idStr(file.fileId) } : {}),
        ...(rawBitRate !== undefined ? { rawBitRate } : {}),
      });
    };
    // `files` keep their own isLocked flag. `lockedFiles` are always locked.
    // They are not a fallback when the unlocked files are filtered out.
    for (const rawFile of filesFrom(response)) pushFile(rawFile, false);
    for (const rawFile of lockedFilesFrom(response)) pushFile(rawFile, true);
  }
  return out;
}

function toSelected(row: MappedFile): SelectedSearchFile {
  return {
    username: row.track.peer,
    filename: row.track.path,
    size: row.track.sizeBytes,
    ...(row.responseId ? { responseId: row.responseId } : {}),
    ...(row.fileId ? { fileId: row.fileId } : {}),
    ...(row.track.format.ext ? { extension: row.track.format.ext } : {}),
    ...(row.rawBitRate !== undefined ? { bitRate: row.rawBitRate } : {}),
    ...(row.track.durationSeconds !== undefined ? { durationSeconds: row.track.durationSeconds } : {}),
  };
}

/**
 * Pick one usable search file and record why.
 * `score` is `{ pick, breakdown, total, signals }`. `file` is the enqueue shape.
 */
export function selectSearch(payload: unknown, opts: SelectSearchOptions = {}): SearchSelection {
  if (responsesFrom(payload).length === 0) return { outcome: "no_responses" };
  const mapped = collect(payload);
  if (mapped.length === 0) return { outcome: "no_usable_candidate" };
  const decision = selectTracks(
    mapped.map((row) => row.track),
    opts,
  );
  if (decision.outcome !== "selected") return decision;
  const chosen = mapped.find((row) => row.track === decision.pick);
  if (!chosen) return { outcome: "no_usable_candidate" };
  return { ...decision, file: toSelected(chosen) };
}

/**
 * Pick one usable search response file.
 * Returns null when nothing usable is present. Does not relax filters.
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
