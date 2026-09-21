import { OllamaProvider } from "./llm/ollama.js";
import { NavidromeProvider } from "./library/navidrome.js";
import { SubWaveProvider } from "./radio/subwave.js";
import { SoulseekProvider } from "./acquisition/slskd.js";
import { UnverifiedAcquisitionProvider } from "./acquisition/unverified.js";

export { joinUrl, ProviderHttpError, UnverifiedAdapterError } from "./http.js";
export type { FetchLike, ProviderHealth } from "./http.js";
export type {
  LLMProvider,
  MusicLibraryProvider,
  RadioProvider,
  AcquisitionProvider,
  LibrarySong,
  SayKind,
  SayRequest,
  SayResult,
} from "./types.js";
export { SAY_KINDS, SAY_TEXT_MAX_CHARS } from "./types.js";
export { OllamaProvider, NavidromeProvider, SubWaveProvider, SoulseekProvider, UnverifiedAcquisitionProvider };
export { NeverPlayError } from "./radio/subwave.js";
export { createProviders } from "./factory.js";
export type { ProviderBundle } from "./factory.js";
export type { OllamaProviderOptions } from "./llm/ollama.js";
export type { NavidromeProviderOptions } from "./library/navidrome.js";
export type { SubWaveProviderOptions } from "./radio/subwave.js";
export type { SoulseekProviderOptions } from "./acquisition/slskd.js";
export { extractTransferProgress } from "./acquisition/progress.js";
export type { TransferProgress } from "./acquisition/progress.js";
