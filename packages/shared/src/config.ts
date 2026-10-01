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

/** MiB (1 MiB = 1,048,576 bytes). Default hard cap. Larger files are rejected. */
export const DEFAULT_MAX_FILE_SIZE_MB = 30;

/** MiB (1 MiB = 1,048,576 bytes). Default search-hit size floor. */
export const DEFAULT_MIN_FILE_SIZE_MB = 1;

/**
 * MiB (1 MiB = 1,048,576 bytes). Kept so older config files still load.
 * The selector does not grade size. `max_file_size_mb` is the size gate.
 */
export const DEFAULT_PREFERRED_MAX_FILE_SIZE_MB = 30;

/** Broadcast-friendly sample-rate cap (Hz). Files that report a higher rate are not selected. */
export const DEFAULT_MAX_SAMPLE_RATE = 48_000;

/** Broadcast-friendly bit-depth cap. Files that report a higher depth are not selected. */
export const DEFAULT_MAX_BIT_DEPTH = 24;

/** Hard duration cap in seconds. Files that report a longer `length` are excluded. Null disables it. */
export const DEFAULT_MAX_DURATION_SECONDS = 1200;

/**
 * Kept so older config files still load. The selector does not penalize duration.
 * `max_duration_seconds` is the duration gate. A long-recording phrase is a reject.
 */
export const DEFAULT_PREFERRED_MAX_DURATION_SECONDS = 720;

/**
 * Saved version taste. Never a filter.
 * `balanced` is the default order: remix, club, and extended together, then album
 * or original, then radio edit. Any other value moves that class to the front.
 */
export const VERSION_PREFERENCES = ["balanced", "radio_edit", "original", "extended", "remix"] as const;
export type VersionPreference = (typeof VERSION_PREFERENCES)[number];
export const DEFAULT_VERSION_PREFERENCE: VersionPreference = "balanced";

/**
 * Saved format taste, separate from the quality tier.
 * Owner decision: the default is `prefer_mp3`.
 * `mp3_only` and `flac_only` are hard filters. The others are a bonus or nothing.
 */
export const FORMAT_PREFERENCES = ["auto", "prefer_mp3", "prefer_flac", "mp3_only", "flac_only"] as const;
export type FormatPreference = (typeof FORMAT_PREFERENCES)[number];
export const DEFAULT_FORMAT_PREFERENCE: FormatPreference = "prefer_mp3";

/** Lossy bitrates below this (kbps) are penalized. Values outside 32–500 are unknown. */
export const DEFAULT_BITRATE_FLOOR_KBPS = 192;

/**
 * A known duration below this fraction of the search median is short,
 * once at least `DEFAULT_SHORT_RECORDING_MIN_SAMPLES` lengths are known.
 */
export const DEFAULT_SHORT_RECORDING_FRACTION = 0.6;

/** Relative short-track penalty stays off until this many known lengths exist. */
export const DEFAULT_SHORT_RECORDING_MIN_SAMPLES = 5;

/** Known durations below this many seconds are short even without a median. */
export const DEFAULT_SHORT_RECORDING_FLOOR_SECONDS = 90;

/** How long queue_radio waits for GET /dj/search to show a string id. 30 minutes. */
export const DEFAULT_SEARCH_VISIBLE_TIMEOUT_MS = 30 * 60 * 1000;

/** How long a download may stay in progress before the request fails. 6 hours. */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Downloads directory as slskd sees it. Default `/downloads` (container).
 * Mapped onto `paths.downloads` when a transfer reports a path under this prefix.
 */
export const DEFAULT_SLSKD_DOWNLOADS_DIR = "/downloads";

/** Soft short-track penalty reaches this (negative) value. Same scale as a long recording. */
export const DEFAULT_SHORT_RECORDING_PENALTY = -1900;

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

/**
 * Terms that earn the extended/remix bonus when the length is normal.
 * Word-boundary, case-insensitive. A bare "mix" is not in this list.
 */
export const DEFAULT_EXTENDED_VERSION_TERMS = ["remix", "extended", "club mix"] as const;

/**
 * Heavy long-recording penalty. Matched on the basename and the immediate
 * parent folder only. Disc numbering is never a match. A bare "mix" is not here:
 * "extended mix" and "club mix" are normal tracks. "ep." means `ep` plus a number.
 */
export const DEFAULT_LONG_RECORDING_PHRASES = [
  "dj set",
  "live at",
  "live from",
  "full album",
  "full set",
  "podcast",
  "radio show",
  "radioshow",
  "mixshow",
  "continuous mix",
  "mixed by",
  "megamix",
  "essential mix",
  "concert",
  "episode",
  "ep.",
] as const;

const acquisitionSelectionSchema = z
  .object({
    /** Files larger than this (MiB, 1,048,576 bytes) are not selected. */
    max_file_size_mb: z.number().positive().default(DEFAULT_MAX_FILE_SIZE_MB),
    /**
     * Files smaller than this (MiB, 1,048,576 bytes) are not selected.
     * Omit for 1. Null disables the floor.
     */
    min_file_size_mb: z.number().positive().nullable().default(DEFAULT_MIN_FILE_SIZE_MB),
    /**
     * Files whose duration is greater than this (seconds) are not selected.
     * Default 1200. Null disables the cap. Files that do not report a duration stay eligible.
     */
    max_duration_seconds: z.number().positive().nullable().default(DEFAULT_MAX_DURATION_SECONDS),
    /**
     * Unused by the selector. Kept so older yaml still parses.
     * Not compared to max_file_size_mb.
     */
    preferred_max_file_size_mb: z.number().positive().default(DEFAULT_PREFERRED_MAX_FILE_SIZE_MB),
    /**
     * Unused by the selector. Kept so older yaml still parses.
     * Must be less than or equal to max_duration_seconds when that cap is set.
     */
    preferred_max_duration_seconds: z.number().positive().default(DEFAULT_PREFERRED_MAX_DURATION_SECONDS),
    /**
     * Version class order. Default `balanced`: remix, club, and extended first,
     * then album or original, then radio edit. A saved class moves to the front.
     * An explicit version in the request turns this off.
     */
    version_preference: z.enum(VERSION_PREFERENCES).default(DEFAULT_VERSION_PREFERENCE),
    /**
     * `auto` adds nothing. `prefer_mp3` / `prefer_flac` add a bonus and keep the other format eligible.
     * `mp3_only` / `flac_only` are hard filters with no relaxation. Default `prefer_mp3` (owner decision).
     * Separate from the quality tier.
     */
    format_preference: z.enum(FORMAT_PREFERENCES).default(DEFAULT_FORMAT_PREFERENCE),
    /** Lossy kbps below this are penalized. Default 192. */
    bitrate_floor_kbps: z.number().positive().default(DEFAULT_BITRATE_FLOOR_KBPS),
    /**
     * Known duration below this fraction of the correlated-candidate median is short.
     * Default 0.6. Needs `short_recording_min_samples` known lengths.
     */
    short_recording_fraction: z.number().gt(0).lte(1).default(DEFAULT_SHORT_RECORDING_FRACTION),
    /** Minimum known lengths before the median fraction applies. Default 5. */
    short_recording_min_samples: z.number().int().positive().default(DEFAULT_SHORT_RECORDING_MIN_SAMPLES),
    /** Known duration below this (seconds) is short even with no median. Default 90. */
    short_recording_floor_seconds: z.number().positive().default(DEFAULT_SHORT_RECORDING_FLOOR_SECONDS),
    /** Zero disables the short-recording reject. Any other value keeps it. Default −1900. */
    short_recording_penalty: z.number().max(0).default(DEFAULT_SHORT_RECORDING_PENALTY),
    extended_version_terms: z.array(z.string().min(1)).default(() => [...DEFAULT_EXTENDED_VERSION_TERMS]),
    long_recording_phrases: z.array(z.string().min(1)).default(() => [...DEFAULT_LONG_RECORDING_PHRASES]),
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
  .superRefine((value, ctx) => {
    if (value.max_duration_seconds != null && value.preferred_max_duration_seconds > value.max_duration_seconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preferred_max_duration_seconds"],
        message: "preferred_max_duration_seconds must be <= max_duration_seconds",
      });
    }
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
      /** Executable used to check codec and duration. Env: SUBWAVE_FFPROBE_PATH. */
      ffprobe_path: z.string().min(1).default("ffprobe"),
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
      /**
       * Cap on the post-import GET /dj/search wait. Default 30 minutes.
       * Env: SUBWAVE_RADIO_SEARCH_VISIBLE_TIMEOUT_MS.
       */
      search_visible_timeout_ms: z.number().int().positive().default(DEFAULT_SEARCH_VISIBLE_TIMEOUT_MS),
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
    /**
     * Cap on one download, from enqueue until the file is in hand.
     * Default 6 hours. Env: SLSKD_DOWNLOAD_TIMEOUT_MS.
     */
    download_timeout_ms: z.number().int().positive().default(DEFAULT_DOWNLOAD_TIMEOUT_MS),
    /**
     * Downloads directory as slskd sees it (container path). Default `/downloads`.
     * A reported transfer path under this prefix is joined onto `paths.downloads`.
     * Env: SLSKD_DOWNLOADS_PATH_PREFIX.
     */
    downloads_path_prefix: z.string().min(1).default(DEFAULT_SLSKD_DOWNLOADS_DIR),
    /** Deterministic search-hit score. The selector does not call an LLM. */
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
const DEPRECATED_SELECTION_KEYS = [
  {
    key: "extended_version_bonus",
    env: "SLSKD_EXTENDED_VERSION_BONUS",
    replacement: "acquisition.selection.version_preference",
    replacementEnv: "SLSKD_VERSION_PREFERENCE",
  },
  {
    key: "lossless_preference",
    env: "SLSKD_LOSSLESS_PREFERENCE",
    replacement: "acquisition.selection.format_preference",
    replacementEnv: "SLSKD_FORMAT_PREFERENCE",
  },
] as const;

function selectionRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const acquisition = (raw as Record<string, unknown>).acquisition;
  if (!acquisition || typeof acquisition !== "object" || Array.isArray(acquisition)) return null;
  const selection = (acquisition as Record<string, unknown>).selection;
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) return null;
  return selection as Record<string, unknown>;
}

/**
 * Old selector keys are ignored. They are not translated into the new enums.
 * Names only — never a secret value.
 */
export function selectionDeprecationNotes(raw: unknown, env: NodeJS.ProcessEnv): string[] {
  const selection = selectionRecord(raw);
  const notes: string[] = [];
  for (const item of DEPRECATED_SELECTION_KEYS) {
    if (selection && Object.prototype.hasOwnProperty.call(selection, item.key)) {
      notes.push(
        `${item.key} is deprecated and ignored. Use ${item.replacement} (env ${item.replacementEnv}).`,
      );
    }
    const envValue = env[item.env];
    if (typeof envValue === "string" && envValue.trim()) {
      notes.push(`${item.env} is deprecated and ignored. Use ${item.replacementEnv} (${item.replacement}).`);
    }
  }
  return notes;
}

let selectionDeprecationLogged = false;

/** Test helper. Production logs each distinct note at most once per process. */
export function resetDeprecatedSelectionWarning(): void {
  selectionDeprecationLogged = false;
}

/** Doctor warning when a copied install still rejects above the old 200 MiB example. */
export function maxFileSizeUpgradeNote(maxFileSizeMb: number): string | null {
  if (!(maxFileSizeMb > DEFAULT_MAX_FILE_SIZE_MB)) return null;
  return `max_file_size_mb is above ${DEFAULT_MAX_FILE_SIZE_MB}. The recommended web-radio value is ${DEFAULT_MAX_FILE_SIZE_MB}. Existing installs should set acquisition.selection.max_file_size_mb to ${DEFAULT_MAX_FILE_SIZE_MB}.`;
}

export function warnDeprecatedSelection(notes: readonly string[]): void {
  if (selectionDeprecationLogged || notes.length === 0) return;
  selectionDeprecationLogged = true;
  for (const note of notes) console.warn(note);
}

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
  /** Non-secret deprecation notes for doctor. Old selector keys are named here and ignored. */
  deprecation_notes?: string[];
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
  const deprecation_notes = selectionDeprecationNotes(rawObject, env);
  const sizeNote = maxFileSizeUpgradeNote(parsed.acquisition.selection.max_file_size_mb);
  if (sizeNote) deprecation_notes.push(sizeNote);
  warnDeprecatedSelection(deprecation_notes);
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
    deprecation_notes,
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
      search_visible_timeout_ms: config.radio.search_visible_timeout_ms,
      verify_status: config.radio.verify_status,
    },
    acquisition: {
      enabled: config.acquisition.enabled,
      provider: config.acquisition.provider,
      base_url: config.acquisition.base_url,
      verify_status: config.acquisition.verify_status,
      download_timeout_ms: config.acquisition.download_timeout_ms,
      downloads_path_prefix: config.acquisition.downloads_path_prefix,
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

export type AcquisitionSettingsPatch = Partial<Omit<AppConfig["acquisition"], "selection">> & {
  selection?: Partial<AppConfig["acquisition"]["selection"]>;
};

export type AppConfigPatch = {
  server?: Partial<AppConfig["server"]>;
  database?: Partial<AppConfig["database"]>;
  paths?: Partial<Pick<AppConfig["paths"], "downloads" | "staging" | "library">>;
  files?: Partial<AppConfig["files"]>;
  auth?: Partial<Pick<AppConfig["auth"], "admin_username" | "session_ttl_hours">>;
  policy?: Partial<AppConfig["policy"]>;
  llm?: Partial<Pick<AppConfig["llm"], "base_url" | "model" | "timeout_ms" | "verify_status">>;
  library?: Partial<Pick<AppConfig["library"], "base_url" | "username" | "verify_status">>;
  radio?: Partial<Pick<AppConfig["radio"], "base_url" | "admin_user" | "search_visible_timeout_ms" | "verify_status">>;
  acquisition?: AcquisitionSettingsPatch;
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
  incoming: AcquisitionSettingsPatch | undefined,
  options: { apiKeyChanged?: boolean } = {},
): AcquisitionSettingsPatch {
  const next: AcquisitionSettingsPatch = { ...(incoming ?? {}) };
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
  if (patch.acquisition) {
    const { selection, ...rest } = patch.acquisition;
    Object.assign(next.acquisition, rest);
    if (selection) Object.assign(next.acquisition.selection, selection);
  }
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
      search_visible_timeout_ms: config.radio.search_visible_timeout_ms,
    },
    acquisition: {
      enabled: config.acquisition.enabled,
      provider: config.acquisition.provider,
      base_url: config.acquisition.base_url,
      download_timeout_ms: config.acquisition.download_timeout_ms,
      downloads_path_prefix: config.acquisition.downloads_path_prefix,
      selection: selectionSettings(config.acquisition.selection),
    },
  };
  return `# Written by Sub Wave AI setup/settings. Secrets stay in paths.secrets_dir.\n${stringifyYaml(doc)}`;
}

function selectionSettings(selection: AppConfig["acquisition"]["selection"]) {
  return {
    max_file_size_mb: selection.max_file_size_mb,
    min_file_size_mb: selection.min_file_size_mb,
    preferred_max_file_size_mb: selection.preferred_max_file_size_mb,
    max_duration_seconds: selection.max_duration_seconds ?? null,
    preferred_max_duration_seconds: selection.preferred_max_duration_seconds,
    version_preference: selection.version_preference,
    format_preference: selection.format_preference,
    bitrate_floor_kbps: selection.bitrate_floor_kbps,
    short_recording_fraction: selection.short_recording_fraction,
    short_recording_min_samples: selection.short_recording_min_samples,
    short_recording_floor_seconds: selection.short_recording_floor_seconds,
    short_recording_penalty: selection.short_recording_penalty,
    max_sample_rate: selection.max_sample_rate,
    max_bit_depth: selection.max_bit_depth,
    version_penalty_terms: [...selection.version_penalty_terms],
    extended_version_terms: [...selection.extended_version_terms],
    long_recording_phrases: [...selection.long_recording_phrases],
    instrument_part_basenames: [...selection.instrument_part_basenames],
  };
}

export function writeAppConfig(filePath: string, config: AppConfig): void {
  const resolved = path.resolve(filePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, serializeAppConfig(config), { encoding: "utf8" });
}
