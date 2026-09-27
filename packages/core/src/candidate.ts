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
  /** Lossy bitrate in kbps, only when the provider reported a plausible value. */
  bitrateKbps?: number;
  sampleRateHz?: number;
  bitDepth?: number;
  /** Reported VBR flag. Scoring does not guess a bitrate from it. */
  vbr?: boolean;
  availability?: TrackAvailability;
  locked: boolean;
};
