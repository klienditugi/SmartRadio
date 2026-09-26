import type { FastifyInstance } from "fastify";
import {
  countUsers,
  insertUser,
  listIntegrationChecks,
  listProviders,
  listSettings,
  openDatabase,
  putSetting,
  upsertIntegrationCheck,
  upsertProvider,
  type Db,
} from "@subwave-ai/db";
import {
  applyStoredVerification,
  CONFIGURED_UNVERIFIED_MESSAGE,
  findMatchingIntegrationCheck,
  integrationConfigFingerprint,
  integrationIsConfigured,
  integrationStatus,
  isNavidromeConfigured,
  isOllamaConfigured,
  isSubwaveRadioConfigured,
  loadConfig,
  mergeAppConfigPatch,
  publicSettings,
  writableConfigPath,
  writeAppConfig,
  type AppConfig,
  type AppConfigPatch,
  type CoreIntegration,
  type IntegrationName,
  type IntegrationReport,
  type RuntimeConfig,
  type StoredIntegrationCheck,
} from "@subwave-ai/shared";
import { hashPassword } from "./auth.js";
import { diskReport } from "./disk.js";

declare module "fastify" {
  interface FastifyInstance {
    config: RuntimeConfig;
    db: Db;
  }
  interface FastifyRequest {
    user?: {
      id: string;
      username: string;
      role: string;
    };
  }
}

export async function seedAdmin(db: Db, config: RuntimeConfig): Promise<void> {
  if (countUsers(db) > 0) return;
  if (!config.secrets.adminPassword) return;
  const passwordHash = await hashPassword(config.secrets.adminPassword);
  insertUser(db, {
    username: config.auth.admin_username,
    passwordHash,
    role: "admin",
  });
}

export function syncProviders(db: Db, config: RuntimeConfig): void {
  upsertProvider(db, {
    id: "llm-ollama",
    kind: "llm",
    name: "OllamaProvider",
    verifyStatus: config.llm.verify_status,
    config: { base_url: config.llm.base_url, model: config.llm.model, provider: "ollama" },
  });
  upsertProvider(db, {
    id: "library-navidrome",
    kind: "library",
    name: "NavidromeProvider",
    verifyStatus: config.library.verify_status,
    config: { base_url: config.library.base_url, username: config.library.username, provider: "navidrome" },
  });
  upsertProvider(db, {
    id: "radio-subwave",
    kind: "radio",
    name: "SubWaveProvider",
    verifyStatus: config.radio.verify_status,
    config: { base_url: config.radio.base_url, admin_user: config.radio.admin_user, provider: "subwave" },
  });
  const slskd = config.acquisition.provider === "slskd";
  upsertProvider(db, {
    id: "acquisition-slskd",
    kind: "acquisition",
    name: slskd ? "SoulseekProvider" : "UnverifiedAcquisitionProvider",
    verifyStatus: config.acquisition.verify_status,
    enabled: config.acquisition.enabled && slskd,
    config: { base_url: config.acquisition.base_url, provider: config.acquisition.provider },
  });
}

export function commitRuntimeConfig(app: FastifyInstance, next: AppConfig): void {
  writeAppConfig(writableConfigPath(), next);
  const reloaded = loadConfig({ configPath: writableConfigPath() });
  applyStoredVerification(reloaded, listIntegrationChecks(app.db));
  replaceRuntimeConfig(app, reloaded);
  syncProviders(app.db, app.config);
}

/** Persist a test-connection probe. `ready` is the only state that verifies the current fingerprint. */
export function recordIntegrationProbe(app: FastifyInstance, integration: IntegrationName, state: string): void {
  const fingerprint = integrationConfigFingerprint(app.config, integration);
  if (fingerprint) {
    upsertIntegrationCheck(app.db, {
      integration,
      state,
      fingerprint,
      testedAt: Date.now(),
    });
  }
  applyStoredVerification(app.config, listIntegrationChecks(app.db));
  syncProviders(app.db, app.config);
}

export function matchingIntegrationCheck(config: RuntimeConfig, db: Db, integration: IntegrationName): StoredIntegrationCheck | null {
  return findMatchingIntegrationCheck(config, integration, listIntegrationChecks(db));
}

export function commitConfigPatch(app: FastifyInstance, patch: AppConfigPatch): void {
  commitRuntimeConfig(app, mergeAppConfigPatch(app.config, patch));
}

export function replaceRuntimeConfig(app: FastifyInstance, next: RuntimeConfig): void {
  const target = app.config as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(next)) {
    target[key] = value;
  }
}

export function acquisitionUnavailable(config: RuntimeConfig): boolean {
  if (!config.acquisition.enabled) return true;
  if (config.acquisition.provider !== "slskd") return true;
  const url = config.acquisition.base_url.trim();
  const key = (config.secrets.slskdApiKey ?? "").trim();
  if (!url || !key) return true;
  return config.acquisition.verify_status !== "verified";
}

function integrationDoctor(
  config: RuntimeConfig,
  kind: CoreIntegration,
  probed: IntegrationReport,
  checks: StoredIntegrationCheck[],
) {
  if (!integrationIsConfigured(config, kind)) {
    return { state: "not_configured" as const, detail: probed.detail, probed: false };
  }
  const check = findMatchingIntegrationCheck(config, kind, checks);
  if (!check) {
    return { state: "configured_unverified" as const, detail: CONFIGURED_UNVERIFIED_MESSAGE, probed: false };
  }
  if (check.state !== "ready") {
    return { state: check.state, detail: check.state, probed: true };
  }
  if (probed.state) return { state: probed.state, detail: probed.detail, probed: probed.probed };
  return { state: "ready" as const, detail: "ready", probed: true };
}

function acquisitionDoctor(config: RuntimeConfig, checks: StoredIntegrationCheck[]) {
  if (!config.acquisition.enabled) {
    return { state: "disabled" as const, detail: "acquisition is disabled", probed: false };
  }
  const url = config.acquisition.base_url.trim();
  const key = Boolean(config.secrets.slskdApiKey?.trim());
  if (config.acquisition.provider !== "slskd" || !url || !key) {
    return { state: "not_configured" as const, detail: "acquisition is missing base_url or API key", probed: false };
  }
  const check = findMatchingIntegrationCheck(config, "acquisition", checks);
  if (!check) {
    return { state: "configured_unverified" as const, detail: CONFIGURED_UNVERIFIED_MESSAGE, probed: false };
  }
  return { state: check.state, detail: check.state === "ready" ? "ready" : check.state, probed: true };
}

export function doctorReport(db: Db, config: RuntimeConfig) {
  let dbOk = true;
  try {
    db.prepare("SELECT 1").get();
  } catch {
    dbOk = false;
  }
  const disk = diskReport(config);
  const acquire_unavailable = acquisitionUnavailable(config);
  const providers = listProviders(db) as Array<{ id: string; last_health_json: string | null }>;
  const checks = listIntegrationChecks(db);
  const healthOf = (id: string) => providers.find((row) => row.id === id)?.last_health_json ?? null;
  const probed = integrationStatus(config, {
    llm: healthOf("llm-ollama"),
    library: healthOf("library-navidrome"),
    radio: healthOf("radio-subwave"),
  });
  const integrations = {
    llm: integrationDoctor(config, "llm", probed.llm, checks),
    library: integrationDoctor(config, "library", probed.library, checks),
    radio: integrationDoctor(config, "radio", probed.radio, checks),
    acquisition: acquisitionDoctor(config, checks),
  };
  const upgradeNotes = (["llm", "library", "radio", "acquisition"] as const)
    .filter((kind) => integrations[kind].state === "configured_unverified")
    .map((kind) => `${kind}: ${CONFIGURED_UNVERIFIED_MESSAGE}`);
  return {
    ok: dbOk && disk.ok,
    database: dbOk,
    disk,
    bind: { host: config.server.host, port: config.server.port },
    ollama: "external-only",
    integrations,
    acquire_unavailable,
    config: publicSettings(config),
    settings: listSettings(db),
    providers,
    notes: [
      "API is sync+enqueue only. Workers own LLM, library, acquisition, radio, and live health probes.",
      "Ollama is never installed, updated, or pulled by this process.",
      "Live URLs/credentials are placeholders unless provided via yaml/env/secrets.",
      "Music library/downloads/staging must be host-mounted persistent paths, never only in an ephemeral container.",
      "Navidrome is passive on the happy path; index_library/startScan is ops-only and is not enqueued after import.",
      "SUB/WAVE notify is POST {radio base_url}/dj/say with admin Basic and mode styled. SmartRadio sends context only for REQUEST_ACCEPTED and TRACK_READY.",
      ...(acquire_unavailable
        ? ["AcquisitionProvider is optional until a verified download daemon exists (acquire_unavailable)."]
        : []),
      ...upgradeNotes,
      ...(!isOllamaConfigured(config) ? ["Ollama is not_configured. Set OLLAMA_BASE_URL and OLLAMA_MODEL on the external host. This process does not install or pull a model."] : []),
      ...(!isNavidromeConfigured(config) ? ["Navidrome is not_configured until URL, username, and password are set."] : []),
      ...(!isSubwaveRadioConfigured(config) ? ["SUB/WAVE radio is not_configured until URL, admin user, and password are set."] : []),
    ],
  };
}

export { putSetting, openDatabase };
