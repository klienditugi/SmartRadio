/**
 * Provider-neutral search hit. Adapters map vendor JSON into this shape.
 * The scoring policy reads only these fields and never calls an LLM.
 */

export type TrackFormat = {
  /** Lowercase, leading dot, from a real extension. Empty when the type is unknown. */
  ext: string;
  /** True for a lossless container (flac, wav). Missing sample rate or bit depth does not clear this. */
  lossless: boolean;
};

export type TrackAvailability = {
  freeSlot?: boolean;
  queueLength?: number;
  /** Peer upload speed in bytes per second, when the provider reported it. */
  speedBps?: number;
};

export type CandidateTrack = {
  peer: string;
  /** Original path, separators unchanged. */
  path: string;
  basename: string;
  /** Parent folders, root first. Does not include the basename. */
  folders: string[];
  sizeBytes: number;
  durationSeconds?: number;
  format: TrackFormat;
  /**
   * Reported lossy bitrate in kbps, including junk. The scorer treats 321 or more,
   * and anything outside 32–500, as unknown. It does not invent a replacement.
   */
  bitrateKbps?: number;
  sampleRateHz?: number;
  bitDepth?: number;
  /**
   * Reported VBR flag (`isVariableBitRate` when the provider sent it).
   * Absent means not VBR. Scoring does not invent the flag or a bitrate from it.
   * A reported MP3 bitrate at or above the VBR good threshold scores as the good tier.
   * The same flag on any other format does not.
   */
  vbr?: boolean;
  availability?: TrackAvailability;
  locked: boolean;
};
