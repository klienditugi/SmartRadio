import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { loadSecrets, type LoadedSecrets } from "./secrets.js";
import {
  describeIntegration,
  NAVIDROME_NOT_CONFIGURED,
  ollamaNotConfiguredDetail,
  SUBWAVE_RADIO_NOT_CONFIGURED,
  type IntegrationReport,
} from "./status.js";

/** Blank, whitespace, null, and missing are the same unset value. No invented default. */
const optionalSetting = z.preprocess((value) => {
  if (value === undefined || value === null) return "";
  return value;
}, z.string().trim());

function nonemptyEnv(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const stationPolicySchema = z.object({
  require_electronic: z.boolean().default(true),
  require_station_match: z.boolean().default(true),
  min_confidence: z.number().min(0).max(1).default(0.55),
  allowed_genres: z.array(z.string()).default([]),
  blocked_artists: z.array(z.string()).default([]),
  blocked_terms: z.array(z.string()).default([]),
});

export type StationPolicy = z.infer<typeof stationPolicySchema>;

export const appConfigSchema = z.object({
  server: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().positive(),
  }),
  database: z.object({
    path: z.string().min(1),
  }),
  paths: z.object({
    secrets_dir: z.string().min(1),
    downloads: z.string().min(1),
    staging: z.string().min(1),
    library: z.string().min(1),
  }),
  files: z
    .object({
      allowed_extensions: z.array(z.string()).default([".mp3", ".flac", ".m4a", ".ogg", ".wav"]),
      max_bytes: z.number().int().positive().default(200 * 1024 * 1024),
    })
    .default({}),
  auth: z
    .object({
      admin_username: z.string().min(1).default("admin"),
      session_ttl_hours: z.number().positive().default(24),
      cookie_name: z.string().min(1).default("subwave_session"),
    })
    .default({}),
  worker: z
    .object({
      id: z.string().min(1).default("worker-1"),
      poll_ms: z.number().int().positive().default(500),
      lease_ms: z.number().int().positive().default(30_000),
      max_attempts: z.number().int().positive().default(5),
    })
    .default({}),
  policy: stationPolicySchema.default({}),
  llm: z
    .object({
      provider: z.literal("ollama").default("ollama"),
      /** Optional. Empty is unset. Never default a model name or host. */
      base_url: optionalSetting,
      model: optionalSetting,
      timeout_ms: z.number().int().positive().default(120_000),
      verify_status: z.enum(["verified", "unverified", "needs_server_inspection"]).default("verified"),
    })
    .default({}),
  library: z
    .object({
      provider: z.literal("navidrome").default("navidrome"),
      /** Optional. Empty URL, username, or password is `not_configured`. */
      base_url: optionalSetting,
      username: optionalSetting,
      client_name: z.string().min(1).default("subwave-ai"),
      api_version: z.string().min(1).default("1.16.1"),
      verify_status: z.enum(["verified", "unverified", "needs_server_inspection"]).default("verified"),
    })
    .default({}),
  radio: z
    .object({
      provider: z.literal("subwave").default("subwave"),
      /** Optional. Empty URL, admin user, or password is `not_configured`. */
      base_url: optionalSetting,
      admin_user: optionalSetting,
      verify_status: z.enum(["verified", "unverified", "needs_server_inspection"]).default("verified"),
    })
    .default({}),
  acquisition: z.object({
    /** Omitted field stays on so existing verified installs keep working. Set false to disable. */
    enabled: z.boolean().default(true),
    /** `slskd` is the only provider with a live check. Other names stay unverified. */
    provider: z.string().trim().min(1).default("slskd"),
    base_url: z.string().trim().default(""),
    /** Omitted means unverified. `verified` is written only after a live test connection. */
    verify_status: z.enum(["verified", "unverified", "needs_server_inspection"]).default("unverified"),
  }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export type RuntimeConfig = AppConfig & { secrets: LoadedSecrets };

const ENV_INTERPOLATION = /\$\{([A-Z0-9_]+)\}/g;

export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_INTERPOLATION, (_match, name: string) => env[name] ?? "");
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnv(item, env));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateEnv(v, env);
    }
    return out;
  }
  return value;
}

export function applyEnvOverrides(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const next = structuredClone(raw);

  const set = (obj: Record<string, unknown>, key: string, value: unknown) => {
    obj[key] = value;
  };

  const server = (next.server ?? {}) as Record<string, unknown>;
  if (env.SUBWAVE_API_HOST) set(server, "host", env.SUBWAVE_API_HOST);
  if (env.SUBWAVE_API_PORT) set(server, "port", Number(env.SUBWAVE_API_PORT));
  next.server = server;

  const database = (next.database ?? {}) as Record<string, unknown>;
  if (env.SUBWAVE_DB_PATH) set(database, "path", env.SUBWAVE_DB_PATH);
  next.database = database;

  const paths = (next.paths ?? {}) as Record<string, unknown>;
  if (env.SUBWAVE_SECRETS_DIR) set(paths, "secrets_dir", env.SUBWAVE_SECRETS_DIR);
  if (env.SUBWAVE_DOWNLOADS_DIR) set(paths, "downloads", env.SUBWAVE_DOWNLOADS_DIR);
  if (env.SUBWAVE_STAGING_DIR) set(paths, "staging", env.SUBWAVE_STAGING_DIR);
  if (env.SUBWAVE_LIBRARY_DIR) set(paths, "library", env.SUBWAVE_LIBRARY_DIR);
  next.paths = paths;

  const auth = (next.auth ?? {}) as Record<string, unknown>;
  if (env.SUBWAVE_ADMIN_USERNAME) set(auth, "admin_username", env.SUBWAVE_ADMIN_USERNAME);
  next.auth = auth;

  const llm = (next.llm ?? {}) as Record<string, unknown>;
  const ollamaUrl = nonemptyEnv(env.OLLAMA_BASE_URL);
  const ollamaModel = nonemptyEnv(env.OLLAMA_MODEL);
  if (ollamaUrl) set(llm, "base_url", ollamaUrl);
  if (ollamaModel) set(llm, "model", ollamaModel);
  next.llm = llm;

  const library = (next.library ?? {}) as Record<string, unknown>;
  const navidromeUrl = nonemptyEnv(env.NAVIDROME_URL);
  const navidromeUser = nonemptyEnv(env.NAVIDROME_USER);
  if (navidromeUrl) set(library, "base_url", navidromeUrl);
  if (navidromeUser) set(library, "username", navidromeUser);
  next.library = library;

  const radio = (next.radio ?? {}) as Record<string, unknown>;
  const radioUrl = nonemptyEnv(env.SUBWAVE_RADIO_URL);
  const radioUser = nonemptyEnv(env.SUBWAVE_RADIO_ADMIN_USER);
  if (radioUrl) set(radio, "base_url", radioUrl);
  if (radioUser) set(radio, "admin_user", radioUser);
  next.radio = radio;

  const acquisition = (next.acquisition ?? {}) as Record<string, unknown>;
  if (env.SLSKD_URL) set(acquisition, "base_url", env.SLSKD_URL);
  next.acquisition = acquisition;

  return next;
}

export function parseAppConfig(input: unknown): AppConfig {
  return appConfigSchema.parse(input);
}

export type LoadConfigOptions = {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  secretsDir?: string;
};

function findWorkspaceRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

function resolveFromRoot(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(findWorkspaceRoot(), filePath);
}

function resolveConfigPath(env: NodeJS.ProcessEnv, explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (env.SUBWAVE_CONFIG) return resolveFromRoot(env.SUBWAVE_CONFIG);
  const root = findWorkspaceRoot();
  const local = path.join(root, "config/subwave.yaml");
  if (existsSync(local)) return local;
  return path.join(root, "config/subwave.example.yaml");
}

export function writableConfigPath(env: NodeJS.ProcessEnv = process.env, explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (env.SUBWAVE_CONFIG) return resolveFromRoot(env.SUBWAVE_CONFIG);
  return path.join(findWorkspaceRoot(), "config/subwave.yaml");
}

export function loadConfig(options: LoadConfigOptions = {}): RuntimeConfig {
  const env = options.env ?? process.env;
  const configPath = resolveConfigPath(env, options.configPath);
  if (!existsSync(configPath)) {
    throw new Error(`config file not found: ${configPath}`);
  }
  const rawYaml = parseYaml(readFileSync(configPath, "utf8"));
  const interpolated = interpolateEnv(rawYaml, env) as Record<string, unknown>;
  const overridden = applyEnvOverrides(interpolated, env);
  const parsed = parseAppConfig(overridden);
  const secretsDir = options.secretsDir
    ? path.resolve(options.secretsDir)
    : path.resolve(parsed.paths.secrets_dir);
  const secrets = loadSecrets(secretsDir);
  return {
    ...parsed,
    paths: { ...parsed.paths, secrets_dir: secretsDir },
    secrets,
  };
}

export function isOllamaConfigured(config: RuntimeConfig): boolean {
  return Boolean(config.llm.base_url.trim() && config.llm.model.trim());
}

export function isNavidromeConfigured(config: RuntimeConfig): boolean {
  return Boolean(
    config.library.base_url.trim() && config.library.username.trim() && config.secrets.navidromePassword?.trim(),
  );
}

export function isSubwaveRadioConfigured(config: RuntimeConfig): boolean {
  return Boolean(
    config.radio.base_url.trim() && config.radio.admin_user.trim() && config.secrets.subwaveAdminPassword?.trim(),
  );
}

export type IntegrationStatusMap = {
  llm: IntegrationReport;
  library: IntegrationReport;
  radio: IntegrationReport;
};

export function integrationStatus(
  config: RuntimeConfig,
  health: { llm?: string | null; library?: string | null; radio?: string | null } = {},
): IntegrationStatusMap {
  return {
    llm: describeIntegration(
      isOllamaConfigured(config),
      ollamaNotConfiguredDetail({ baseUrl: config.llm.base_url, model: config.llm.model }),
      health.llm,
    ),
    library: describeIntegration(isNavidromeConfigured(config), NAVIDROME_NOT_CONFIGURED, health.library),
    radio: describeIntegration(isSubwaveRadioConfigured(config), SUBWAVE_RADIO_NOT_CONFIGURED, health.radio),
  };
}

export function publicSettings(config: RuntimeConfig) {
  return {
    server: { host: config.server.host, port: config.server.port },
    policy: config.policy,
    files: config.files,
    llm: {
      provider: config.llm.provider,
      base_url: config.llm.base_url,
      model: config.llm.model,
      verify_status: config.llm.verify_status,
    },
    library: {
      provider: config.library.provider,
      base_url: config.library.base_url,
      username: config.library.username,
      verify_status: config.library.verify_status,
    },
    radio: {
      provider: config.radio.provider,
      base_url: config.radio.base_url,
      admin_user: config.radio.admin_user,
      verify_status: config.radio.verify_status,
    },
    acquisition: {
      enabled: config.acquisition.enabled,
      provider: config.acquisition.provider,
      base_url: config.acquisition.base_url,
      verify_status: config.acquisition.verify_status,
    },
    integrations: integrationStatus(config),
    secrets_present: {
      admin_password: Boolean(config.secrets.adminPassword),
      session_secret: Boolean(config.secrets.sessionSecret),
      navidrome_password: Boolean(config.secrets.navidromePassword),
      subwave_admin_password: Boolean(config.secrets.subwaveAdminPassword),
      slskd_api_key: Boolean(config.secrets.slskdApiKey),
    },
    paths: {
      downloads: config.paths.downloads,
      staging: config.paths.staging,
      library: config.paths.library,
      secrets_dir: config.paths.secrets_dir,
      database: config.database.path,
    },
  };
}

export type AppConfigPatch = {
  server?: Partial<AppConfig["server"]>;
  database?: Partial<AppConfig["database"]>;
  paths?: Partial<Pick<AppConfig["paths"], "downloads" | "staging" | "library">>;
  files?: Partial<AppConfig["files"]>;
  auth?: Partial<Pick<AppConfig["auth"], "admin_username" | "session_ttl_hours">>;
  policy?: Partial<AppConfig["policy"]>;
  llm?: Partial<Pick<AppConfig["llm"], "base_url" | "model" | "timeout_ms">>;
  library?: Partial<Pick<AppConfig["library"], "base_url" | "username">>;
  radio?: Partial<Pick<AppConfig["radio"], "base_url" | "admin_user">>;
  acquisition?: Partial<Pick<AppConfig["acquisition"], "enabled" | "provider" | "base_url" | "verify_status">>;
};

/**
 * Settings saves may persist enabled, provider, base URL, and a non-verified status.
 * They cannot promote verify_status to verified. URL, provider, or API key changes clear it.
 */
export function normalizeAcquisitionSettingsPatch(
  current: AppConfig["acquisition"],
  incoming: Partial<AppConfig["acquisition"]> | undefined,
  options: { apiKeyChanged?: boolean } = {},
): Partial<AppConfig["acquisition"]> {
  const next: Partial<AppConfig["acquisition"]> = { ...(incoming ?? {}) };
  if (typeof next.base_url === "string") next.base_url = next.base_url.trim();
  if (typeof next.provider === "string") next.provider = next.provider.trim();
  if (next.verify_status === "verified") delete next.verify_status;
  const urlChanged = next.base_url !== undefined && next.base_url !== current.base_url.trim();
  const providerChanged = next.provider !== undefined && next.provider !== current.provider;
  if (urlChanged || providerChanged || options.apiKeyChanged) {
    next.verify_status = "unverified";
  }
  return next;
}

export function mergeAppConfigPatch(base: AppConfig, patch: AppConfigPatch): AppConfig {
  const next = structuredClone(base) as AppConfig;
  if (patch.server) Object.assign(next.server, patch.server);
  if (patch.database) Object.assign(next.database, patch.database);
  if (patch.paths) Object.assign(next.paths, patch.paths);
  if (patch.files) Object.assign(next.files, patch.files);
  if (patch.auth) Object.assign(next.auth, patch.auth);
  if (patch.policy) Object.assign(next.policy, patch.policy);
  if (patch.llm) Object.assign(next.llm, patch.llm);
  if (patch.library) Object.assign(next.library, patch.library);
  if (patch.radio) Object.assign(next.radio, patch.radio);
  if (patch.acquisition) Object.assign(next.acquisition, patch.acquisition);
  return parseAppConfig(next);
}

export function serializeAppConfig(config: AppConfig): string {
  const doc = {
    server: config.server,
    database: config.database,
    paths: config.paths,
    files: config.files,
    auth: config.auth,
    worker: config.worker,
    policy: config.policy,
    llm: {
      provider: config.llm.provider,
      base_url: config.llm.base_url,
      model: config.llm.model,
      timeout_ms: config.llm.timeout_ms,
      verify_status: config.llm.verify_status,
    },
    library: {
      provider: config.library.provider,
      base_url: config.library.base_url,
      username: config.library.username,
      client_name: config.library.client_name,
      api_version: config.library.api_version,
      verify_status: config.library.verify_status,
    },
    radio: {
      provider: config.radio.provider,
      base_url: config.radio.base_url,
      admin_user: config.radio.admin_user,
      verify_status: config.radio.verify_status,
    },
    acquisition: {
      enabled: config.acquisition.enabled,
      provider: config.acquisition.provider,
      base_url: config.acquisition.base_url,
      verify_status: config.acquisition.verify_status,
    },
  };
  return `# Written by Sub Wave AI setup/settings. Secrets stay in paths.secrets_dir.\n${stringifyYaml(doc)}`;
}

export function writeAppConfig(filePath: string, config: AppConfig): void {
  const resolved = path.resolve(filePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, serializeAppConfig(config), { encoding: "utf8" });
}
