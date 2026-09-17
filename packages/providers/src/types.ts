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

export interface RadioProvider {
  readonly kind: "subwave";
  readonly verifyStatus: VerifyStatus;
  health(): Promise<ProviderHealth>;
  nowPlaying(): Promise<unknown>;
  state(): Promise<unknown>;
  djSearch(query: string, opts?: { limit?: number; offset?: number }): Promise<unknown>;
  queueTrack(track: { id: string; title: string; artist?: string }): Promise<unknown>;
  refreshPlaylist(): Promise<unknown>;
  /** Secondary public path — automation must prefer djSearch + queueTrack. */
  publicRequest(body: { text: string; name?: string }): Promise<unknown>;
  publicRequestStatus(id: string): Promise<unknown>;
}

export interface AcquisitionProvider {
  readonly kind: "slskd" | "unverified";
  readonly verifyStatus: VerifyStatus;
  search(searchText: string, id: string): Promise<unknown>;
  enqueueDownload(user: string, files: unknown): Promise<unknown>;
  listDownloads(): Promise<unknown>;
  health(): Promise<ProviderHealth>;
}
