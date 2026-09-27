import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { applyEnvOverrides, fieldSourcesFor, type FieldSources } from "./field-source.js";
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

/** Mebibytes (1024×1024 bytes). Default search-hit size cap. */
export const DEFAULT_MAX_FILE_SIZE_MB = 200;

/** Mebibytes (1024×1024 bytes). Default search-hit size floor. */
export const DEFAULT_MIN_FILE_SIZE_MB = 1;

/** Broadcast-friendly sample-rate cap (Hz). Files that report a higher rate are not selected. */
export const DEFAULT_MAX_SAMPLE_RATE = 48_000;

/** Broadcast-friendly bit-depth cap. Files that report a higher depth are not selected. */
export const DEFAULT_MAX_BIT_DEPTH = 24;

/**
 * Basename / parent-folder words that rank below a clean match.
 * Word-boundary and case-insensitive. When the request artist or title contains
 * a term, files that match that term rank above files that do not.
 */
export const DEFAULT_VERSION_PENALTY_TERMS = [
  "remix",
  "live",
  "edit",
  "extended",
  "radio edit",
  "instrumental",
  "karaoke",
  "cover",
  "acapella",
  "a cappella",
  "acappella",
  "stem",
  "stems",
  "multitrack",
  "demo",
] as const;

/**
 * Basename tokens that rank below a full track when the basename itself does
 * not contain the request title. Penalty only — the file can still be selected.
 * Whole tokens, case-insensitive. `song` covers Rock Band `song.ogg`.
 */
export const DEFAULT_INSTRUMENT_PART_BASENAMES = [
  "drums",
  "drum",
  "bass",
  "guitar",
  "guitars",
  "vocals",
  "vocal",
  "vox",
  "keys",
  "piano",
  "synth",
  "backing",
  "click",
  "rhythm",
  "lead",
  "song",
  "crowd",
  "preview",
] as const;

const acquisitionSelectionSchema = z
  .object({
    /** Files larger than this (mebibytes, 1024×1024) are not selected. */
    max_file_size_mb: z.number().positive().default(DEFAULT_MAX_FILE_SIZE_MB),
    /**
     * Files smaller than this (mebibytes, 1024×1024) are not selected.
     * Omit for 1. Null disables the floor.
     */
    min_file_size_mb: z.number().positive().nullable().default(DEFAULT_MIN_FILE_SIZE_MB),
    /**
     * When set, files whose slskd `length` (seconds) is greater than this are not selected.
     * Omit or null: no duration limit. Files that do not report `length` stay eligible.
     */
    max_duration_seconds: z.number().positive().nullable().optional(),
    /**
     * Hz. Files that report `sampleRate` above this are not selected.
     * Omit for the broadcast-friendly default (48000). Null disables the cap.
     * Files that do not report `sampleRate` stay eligible.
     */
    max_sample_rate: z.number().int().positive().nullable().default(DEFAULT_MAX_SAMPLE_RATE),
    /**
     * Files that report `bitDepth` above this are not selected.
     * Omit for the broadcast-friendly default (24). Null disables the cap.
     * Files that do not report `bitDepth` stay eligible.
     */
    max_bit_depth: z.number().int().positive().nullable().default(DEFAULT_MAX_BIT_DEPTH),
    version_penalty_terms: z.array(z.string().min(1)).default(() => [...DEFAULT_VERSION_PENALTY_TERMS]),
    /**
     * Basename tokens that rank below a track file when the basename does not
     * contain the request title. Empty array disables the penalty.
     */
    instrument_part_basenames: z.array(z.string().min(1)).default(() => [...DEFAULT_INSTRUMENT_PART_BASENAMES]),
  })
  .default({});

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
      /** Parsed for old configs. Ignored as a source of verified. */
      verify_status: z.enum(["verified", "unverified", "needs_server_inspection"]).default("unverified"),
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
      /** Parsed for old configs. Ignored as a source of verified. */
      verify_status: z.enum(["verified", "unverified", "needs_server_inspection"]).default("unverified"),
    })
    .default({}),
  radio: z
    .object({
      provider: z.literal("subwave").default("subwave"),
      /** Optional. Empty URL, admin user, or password is `not_configured`. */
      base_url: optionalSetting,
      admin_user: optionalSetting,
      /** Parsed for old configs. Ignored as a source of verified. */
      verify_status: z.enum(["verified", "unverified", "needs_server_inspection"]).default("unverified"),
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
    /** Deterministic search-hit ranking. Yaml/env; the settings UI does not edit this. */
    selection: acquisitionSelectionSchema,
  }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export type CoreIntegration = "llm" | "library" | "radio";

/** Shown when settings are filled and no stored test-connection result matches. Not a promotion to verified. */
export const CONFIGURED_UNVERIFIED_MESSAGE = "configured but unverified, run test connection";

const VERIFY_STATUS_SECTIONS = ["llm", "library", "radio", "acquisition"] as const;

let verifyStatusDeprecationLogged = false;

/** Test helper. Production logs at most once per process. */
export function resetDeprecatedVerifyStatusWarning(): void {
  verifyStatusDeprecationLogged = false;
}

/**
 * One non-secret warning when yaml or env still carries verify_status.
 * The value is ignored. Section and env key names only.
 */
export function warnDeprecatedVerifyStatus(raw: unknown, env: NodeJS.ProcessEnv): void {
  if (verifyStatusDeprecationLogged) return;
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const sections = VERIFY_STATUS_SECTIONS.filter((key) => {
    const section = root[key];
    return Boolean(section && typeof section === "object" && !Array.isArray(section) && "verify_status" in section);
  });
  const envKeys = Object.keys(env).filter((key) => /verify_status/i.test(key));
  if (sections.length === 0 && envKeys.length === 0) return;
  verifyStatusDeprecationLogged = true;
  const where = [...sections, ...envKeys].join(", ");
  console.warn(
    `verify_status in yaml or env is deprecated and ignored (${where}). Verified comes only from a stored test-connection result.`,
  );
}

export type VerifyStatusExplicit = Record<CoreIntegration, boolean>;

export function readVerifyStatusExplicit(raw: unknown): VerifyStatusExplicit {
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const present = (key: CoreIntegration) => {
    const section = root[key];
    return Boolean(section && typeof section === "object" && !Array.isArray(section) && "verify_status" in section);
  };
  return { llm: present("llm"), library: present("library"), radio: present("radio") };
}

export type RuntimeConfig = AppConfig & {
  secrets: LoadedSecrets;
  /** False when that section's yaml/env object omitted verify_status and the schema default applied. */
  verify_status_explicit?: VerifyStatusExplicit;
  /** Where each reported setting came from. Env-pinned fields cannot be saved over. */
  field_sources?: FieldSources;
};

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

export { applyEnvOverrides } from "./field-source.js";

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
  const rawObject =
    rawYaml && typeof rawYaml === "object" && !Array.isArray(rawYaml) ? (rawYaml as Record<string, unknown>) : {};
  const interpolated = interpolateEnv(rawObject, env) as Record<string, unknown>;
  const overridden = applyEnvOverrides(interpolated, env);
  const parsed = parseAppConfig(overridden);
  warnDeprecatedVerifyStatus(overridden, env);
  for (const section of VERIFY_STATUS_SECTIONS) {
    parsed[section].verify_status = "unverified";
  }
  const secretsDir = options.secretsDir
    ? path.resolve(options.secretsDir)
    : path.resolve(parsed.paths.secrets_dir);
  const secrets = loadSecrets(secretsDir);
  return {
    ...parsed,
    paths: { ...parsed.paths, secrets_dir: secretsDir },
    secrets,
    verify_status_explicit: readVerifyStatusExplicit(overridden),
    field_sources: fieldSourcesFor(rawObject, env),
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

export function integrationIsConfigured(config: RuntimeConfig, kind: CoreIntegration): boolean {
  if (kind === "llm") return isOllamaConfigured(config);
  if (kind === "library") return isNavidromeConfigured(config);
  return isSubwaveRadioConfigured(config);
}

/** Filled settings that are not verified by a stored test-connection result. */
export function isConfiguredUnverified(config: RuntimeConfig, kind: CoreIntegration): boolean {
  if (!integrationIsConfigured(config, kind)) return false;
  return config[kind].verify_status !== "verified";
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
      selection: selectionSettings(config.acquisition.selection),
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
  llm?: Partial<Pick<AppConfig["llm"], "base_url" | "model" | "timeout_ms" | "verify_status">>;
  library?: Partial<Pick<AppConfig["library"], "base_url" | "username" | "verify_status">>;
  radio?: Partial<Pick<AppConfig["radio"], "base_url" | "admin_user" | "verify_status">>;
  acquisition?: Partial<Pick<AppConfig["acquisition"], "enabled" | "provider" | "base_url" | "verify_status">>;
};

/**
 * Settings saves may persist enabled, provider, base URL, and a non-verified status.
 * They cannot promote verify_status to verified. URL, provider, or API key changes clear it.
 */
const SETTINGS_CANNOT_VERIFY = "verify_status cannot be set to verified by saving settings; use test-connection";

/** Setup and settings saves cannot promote any integration to verified. */
export function assertSettingsDoNotVerify(patch: AppConfigPatch | undefined): void {
  const sections = [patch?.llm, patch?.library, patch?.radio, patch?.acquisition];
  if (sections.some((section) => section?.verify_status === "verified")) {
    throw new Error(SETTINGS_CANNOT_VERIFY);
  }
}

/**
 * URL, model, username, or password changes clear verify_status.
 * They do not grant verified.
 */
export function clearIntegrationVerifyOnChange(
  current: AppConfig,
  patch: AppConfigPatch,
  changed: { navidromePassword?: boolean; radioPassword?: boolean } = {},
): AppConfigPatch {
  const next: AppConfigPatch = { ...patch };
  const llm = next.llm;
  const llmChanged = Boolean(
    llm &&
      ((llm.base_url !== undefined && llm.base_url !== current.llm.base_url) ||
        (llm.model !== undefined && llm.model !== current.llm.model)),
  );
  if (llmChanged && llm) next.llm = { ...llm, verify_status: "unverified" };

  const library = next.library;
  const libraryChanged =
    Boolean(changed.navidromePassword) ||
    Boolean(
      library &&
        ((library.base_url !== undefined && library.base_url !== current.library.base_url) ||
          (library.username !== undefined && library.username !== current.library.username)),
    );
  if (libraryChanged) next.library = { ...(library ?? {}), verify_status: "unverified" };

  const radio = next.radio;
  const radioChanged =
    Boolean(changed.radioPassword) ||
    Boolean(
      radio &&
        ((radio.base_url !== undefined && radio.base_url !== current.radio.base_url) ||
          (radio.admin_user !== undefined && radio.admin_user !== current.radio.admin_user)),
    );
  if (radioChanged) next.radio = { ...(radio ?? {}), verify_status: "unverified" };
  return next;
}

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
    },
    library: {
      provider: config.library.provider,
      base_url: config.library.base_url,
      username: config.library.username,
      client_name: config.library.client_name,
      api_version: config.library.api_version,
    },
    radio: {
      provider: config.radio.provider,
      base_url: config.radio.base_url,
      admin_user: config.radio.admin_user,
    },
    acquisition: {
      enabled: config.acquisition.enabled,
      provider: config.acquisition.provider,
      base_url: config.acquisition.base_url,
      selection: selectionSettings(config.acquisition.selection),
    },
  };
  return `# Written by Sub Wave AI setup/settings. Secrets stay in paths.secrets_dir.\n${stringifyYaml(doc)}`;
}

function selectionSettings(selection: AppConfig["acquisition"]["selection"]) {
  return {
    max_file_size_mb: selection.max_file_size_mb,
    min_file_size_mb: selection.min_file_size_mb,
    ...(selection.max_duration_seconds != null ? { max_duration_seconds: selection.max_duration_seconds } : {}),
    max_sample_rate: selection.max_sample_rate,
    max_bit_depth: selection.max_bit_depth,
    version_penalty_terms: [...selection.version_penalty_terms],
    instrument_part_basenames: [...selection.instrument_part_basenames],
  };
}

export function writeAppConfig(filePath: string, config: AppConfig): void {
  const resolved = path.resolve(filePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, serializeAppConfig(config), { encoding: "utf8" });
}
