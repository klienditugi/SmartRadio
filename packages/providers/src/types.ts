import type { Classification, VerifyStatus } from "@subwave-ai/shared";
import type { ProviderHealth } from "./http.js";

export interface LLMProvider {
  readonly kind: "ollama";
  readonly verifyStatus: VerifyStatus;
  classify(input: { text: string; model?: string }): Promise<Classification>;
  health(): Promise<ProviderHealth>;
}

export interface MusicLibraryProvider {
  readonly kind: "navidrome";
  readonly verifyStatus: VerifyStatus;
  search3(query: string, opts?: { songCount?: number; songOffset?: number }): Promise<LibrarySong[]>;
  getSong(id: string): Promise<LibrarySong | null>;
  /** Ops-only. Not required on the A3 happy path (Navidrome scanner is passive). */
  startScan(opts?: { fullScan?: boolean }): Promise<unknown>;
  getScanStatus(): Promise<unknown>;
  health(): Promise<ProviderHealth>;
}

export type LibrarySong = {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  path?: string;
  suffix?: string;
};

/** Unicode code points. SUB/WAVE rejects `text` above this length. */
export const SAY_TEXT_MAX_CHARS = 500;

export const SAY_KINDS = ["dj-speak", "link"] as const;
export type SayKind = (typeof SAY_KINDS)[number];

/**
 * Context for SUB/WAVE `POST /dj/say`. SmartRadio does not choose wording personality:
 * `mode` is always `"styled"` inside the adapter.
 */
export type SayRequest = {
  text: string;
  kind?: SayKind;
  sfx?: unknown;
};

export type SayResult = {
  ok: true;
  mode: string;
  kind: string;
  spoken: string;
  sfx?: unknown;
};

export interface RadioProvider {
  readonly kind: "subwave";
  readonly verifyStatus: VerifyStatus;
  health(): Promise<ProviderHealth>;
  nowPlaying(): Promise<unknown>;
  state(): Promise<unknown>;
  djSearch(query: string, opts?: { limit?: number; offset?: number }): Promise<unknown>;
  /** Admin playback handoff. `artist` and `album` are optional. HTTP 409 is never-play. */
  queueTrack(track: { id: string; title: string; artist?: string; album?: string }): Promise<unknown>;
  refreshPlaylist(): Promise<unknown>;
  /** Admin notify. Context text only; adapter forces `mode: "styled"`. */
  say(input: SayRequest): Promise<SayResult>;
  /** Secondary public path — automation must prefer djSearch + queueTrack. Not used for announcements. */
  publicRequest(body: { text: string; name?: string }): Promise<unknown>;
  publicRequestStatus(id: string): Promise<unknown>;
}

export interface AcquisitionProvider {
  readonly kind: "slskd" | "unverified";
  readonly verifyStatus: VerifyStatus;
  /** POST /api/v0/searches `{ id, searchText }` */
  search(searchText: string, id: string): Promise<unknown>;
  /** GET /api/v0/searches/{id}?includeResponses=true */
  getSearch(id: string, opts?: { includeResponses?: boolean }): Promise<unknown>;
  /** GET /api/v0/searches/{id}/responses — fallback when inline responses are empty */
  getSearchResponses(id: string): Promise<unknown>;
  /** POST /api/v0/transfers/downloads/{username} body `[{filename,size}]` */
  enqueueDownload(user: string, files: unknown): Promise<unknown>;
  /** GET /api/v0/transfers/downloads */
  listDownloads(): Promise<unknown>;
  health(): Promise<ProviderHealth>;
}
