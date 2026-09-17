import type { FetchLike } from "./http.js";
import { OllamaProvider } from "./llm/ollama.js";
import { NavidromeProvider } from "./library/navidrome.js";
import { SubWaveProvider } from "./radio/subwave.js";
import { SoulseekProvider } from "./acquisition/slskd.js";
import { UnverifiedAcquisitionProvider } from "./acquisition/unverified.js";
import type { AcquisitionProvider, LLMProvider, MusicLibraryProvider, RadioProvider } from "./types.js";
import type { RuntimeConfig } from "@subwave-ai/shared";

export type ProviderBundle = {
  llm: LLMProvider;
  library: MusicLibraryProvider;
  radio: RadioProvider;
  acquisition: AcquisitionProvider;
};

export function createProviders(config: RuntimeConfig, fetchImpl?: FetchLike): ProviderBundle {
  const llm = new OllamaProvider({
    baseUrl: config.llm.base_url,
    model: config.llm.model,
    timeoutMs: config.llm.timeout_ms,
    verifyStatus: config.llm.verify_status,
    fetch: fetchImpl,
  });
  const library = new NavidromeProvider({
    baseUrl: config.library.base_url,
    username: config.library.username,
    password: config.secrets.navidromePassword ?? "",
    clientName: config.library.client_name,
    apiVersion: config.library.api_version,
    verifyStatus: config.library.verify_status,
    fetch: fetchImpl,
  });
  const radio = new SubWaveProvider({
    baseUrl: config.radio.base_url,
    adminUser: config.radio.admin_user,
    adminPassword: config.secrets.subwaveAdminPassword ?? "",
    verifyStatus: config.radio.verify_status,
    fetch: fetchImpl,
  });
  const acquisition =
    config.acquisition.provider === "slskd"
      ? new SoulseekProvider({
          baseUrl: config.acquisition.base_url,
          apiKey: config.secrets.slskdApiKey ?? "",
          verifyStatus: config.acquisition.verify_status,
          fetch: fetchImpl,
        })
      : new UnverifiedAcquisitionProvider();
  return { llm, library, radio, acquisition };
}
