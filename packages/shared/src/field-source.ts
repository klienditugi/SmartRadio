export type SettingSource = "env" | "yaml" | "default";

export type FieldSource = {
  source: SettingSource;
  /** Env var name when `source` is `env`. Never a secret value. */
  env?: string;
};

export type FieldSources = Record<string, FieldSource>;

/** Settings leaves reported on GET /settings and GET /setup. `verify_status` is not one of them. */
export const REPORTED_SETTING_PATHS = [
  "server.host",
  "server.port",
  "database.path",
  "paths.secrets_dir",
  "paths.downloads",
  "paths.staging",
  "paths.library",
  "auth.admin_username",
  "auth.session_ttl_hours",
  "files.allowed_extensions",
  "files.max_bytes",
  "files.ffprobe_path",
  "llm.provider",
  "llm.base_url",
  "llm.model",
  "llm.timeout_ms",
  "library.provider",
  "library.base_url",
  "library.username",
  "library.client_name",
  "library.api_version",
  "radio.provider",
  "radio.base_url",
  "radio.admin_user",
  "radio.search_visible_timeout_ms",
  "acquisition.enabled",
  "acquisition.provider",
  "acquisition.base_url",
  "acquisition.download_timeout_ms",
  "acquisition.downloads_path_prefix",
  "acquisition.selection.max_file_size_mb",
  "acquisition.selection.min_file_size_mb",
  "acquisition.selection.preferred_max_file_size_mb",
  "acquisition.selection.max_duration_seconds",
  "acquisition.selection.preferred_max_duration_seconds",
  "acquisition.selection.version_preference",
  "acquisition.selection.format_preference",
  "acquisition.selection.bitrate_floor_kbps",
  "acquisition.selection.short_recording_fraction",
  "acquisition.selection.short_recording_min_samples",
  "acquisition.selection.short_recording_floor_seconds",
  "acquisition.selection.short_recording_penalty",
  "acquisition.selection.max_sample_rate",
  "acquisition.selection.max_bit_depth",
  "acquisition.selection.version_penalty_terms",
  "acquisition.selection.extended_version_terms",
  "acquisition.selection.long_recording_phrases",
  "acquisition.selection.instrument_part_basenames",
] as const;

export class EnvPinnedError extends Error {
  readonly statusCode = 409;
  constructor(path: string, envName: string) {
    super(`${path} is set by ${envName} in .env and cannot be changed here`);
    this.name = "EnvPinnedError";
  }
}

function nonemptyEnv(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truthyEnv(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function positiveEnvNumber(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function enumEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

type EnvAssignment = {
  path: string;
  env: string;
  read: (env: NodeJS.ProcessEnv) => unknown;
};

const ENV_ASSIGNMENTS: readonly EnvAssignment[] = [
  { path: "server.host", env: "SUBWAVE_API_HOST", read: (env) => truthyEnv(env.SUBWAVE_API_HOST) },
  {
    path: "server.port",
    env: "SUBWAVE_API_PORT",
    read: (env) => (truthyEnv(env.SUBWAVE_API_PORT) ? Number(env.SUBWAVE_API_PORT) : undefined),
  },
  { path: "database.path", env: "SUBWAVE_DB_PATH", read: (env) => truthyEnv(env.SUBWAVE_DB_PATH) },
  { path: "paths.secrets_dir", env: "SUBWAVE_SECRETS_DIR", read: (env) => truthyEnv(env.SUBWAVE_SECRETS_DIR) },
  { path: "paths.downloads", env: "SUBWAVE_DOWNLOADS_DIR", read: (env) => truthyEnv(env.SUBWAVE_DOWNLOADS_DIR) },
  { path: "paths.staging", env: "SUBWAVE_STAGING_DIR", read: (env) => truthyEnv(env.SUBWAVE_STAGING_DIR) },
  { path: "paths.library", env: "SUBWAVE_LIBRARY_DIR", read: (env) => truthyEnv(env.SUBWAVE_LIBRARY_DIR) },
  { path: "auth.admin_username", env: "SUBWAVE_ADMIN_USERNAME", read: (env) => truthyEnv(env.SUBWAVE_ADMIN_USERNAME) },
  { path: "llm.base_url", env: "OLLAMA_BASE_URL", read: (env) => nonemptyEnv(env.OLLAMA_BASE_URL) },
  { path: "llm.model", env: "OLLAMA_MODEL", read: (env) => nonemptyEnv(env.OLLAMA_MODEL) },
  { path: "library.base_url", env: "NAVIDROME_URL", read: (env) => nonemptyEnv(env.NAVIDROME_URL) },
  { path: "library.username", env: "NAVIDROME_USER", read: (env) => nonemptyEnv(env.NAVIDROME_USER) },
  { path: "radio.base_url", env: "SUBWAVE_RADIO_URL", read: (env) => nonemptyEnv(env.SUBWAVE_RADIO_URL) },
  { path: "radio.admin_user", env: "SUBWAVE_RADIO_ADMIN_USER", read: (env) => nonemptyEnv(env.SUBWAVE_RADIO_ADMIN_USER) },
  {
    path: "radio.search_visible_timeout_ms",
    env: "SUBWAVE_RADIO_SEARCH_VISIBLE_TIMEOUT_MS",
    read: (env) => positiveEnvNumber(env.SUBWAVE_RADIO_SEARCH_VISIBLE_TIMEOUT_MS),
  },
  { path: "acquisition.base_url", env: "SLSKD_URL", read: (env) => truthyEnv(env.SLSKD_URL) },
  {
    path: "acquisition.download_timeout_ms",
    env: "SLSKD_DOWNLOAD_TIMEOUT_MS",
    read: (env) => positiveEnvNumber(env.SLSKD_DOWNLOAD_TIMEOUT_MS),
  },
  {
    path: "acquisition.downloads_path_prefix",
    env: "SLSKD_DOWNLOADS_PATH_PREFIX",
    read: (env) => nonemptyEnv(env.SLSKD_DOWNLOADS_PATH_PREFIX),
  },
  { path: "files.ffprobe_path", env: "SUBWAVE_FFPROBE_PATH", read: (env) => nonemptyEnv(env.SUBWAVE_FFPROBE_PATH) },
  {
    path: "acquisition.selection.max_file_size_mb",
    env: "SLSKD_MAX_FILE_SIZE_MB",
    read: (env) => positiveEnvNumber(env.SLSKD_MAX_FILE_SIZE_MB),
  },
  {
    path: "acquisition.selection.min_file_size_mb",
    env: "SLSKD_MIN_FILE_SIZE_MB",
    read: (env) => positiveEnvNumber(env.SLSKD_MIN_FILE_SIZE_MB),
  },
  {
    path: "acquisition.selection.preferred_max_file_size_mb",
    env: "SLSKD_PREFERRED_MAX_FILE_SIZE_MB",
    read: (env) => positiveEnvNumber(env.SLSKD_PREFERRED_MAX_FILE_SIZE_MB),
  },
  {
    path: "acquisition.selection.max_duration_seconds",
    env: "SLSKD_MAX_DURATION_SECONDS",
    read: (env) => positiveEnvNumber(env.SLSKD_MAX_DURATION_SECONDS),
  },
  {
    path: "acquisition.selection.preferred_max_duration_seconds",
    env: "SLSKD_PREFERRED_MAX_DURATION_SECONDS",
    read: (env) => positiveEnvNumber(env.SLSKD_PREFERRED_MAX_DURATION_SECONDS),
  },
  {
    path: "acquisition.selection.version_preference",
    env: "SLSKD_VERSION_PREFERENCE",
    read: (env) => enumEnv(env.SLSKD_VERSION_PREFERENCE),
  },
  {
    path: "acquisition.selection.format_preference",
    env: "SLSKD_FORMAT_PREFERENCE",
    read: (env) => enumEnv(env.SLSKD_FORMAT_PREFERENCE),
  },
  {
    path: "acquisition.selection.max_sample_rate",
    env: "SLSKD_MAX_SAMPLE_RATE",
    read: (env) => positiveEnvNumber(env.SLSKD_MAX_SAMPLE_RATE),
  },
  {
    path: "acquisition.selection.max_bit_depth",
    env: "SLSKD_MAX_BIT_DEPTH",
    read: (env) => positiveEnvNumber(env.SLSKD_MAX_BIT_DEPTH),
  },
];

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] ?? "";
    const next = cursor[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1] ?? "";
  cursor[leaf] = value;
}

function hasOwnPath(root: unknown, path: string): boolean {
  let cursor: unknown = root;
  for (const key of path.split(".")) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return false;
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return false;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return true;
}

function valueAt(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const key of path.split(".")) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function sameSetting(current: unknown, next: unknown): boolean {
  if (typeof current === "number" || typeof next === "number") return Number(current) === Number(next);
  if (typeof current === "string" || typeof next === "string") return String(current ?? "").trim() === String(next ?? "").trim();
  return current === next;
}

export function applyEnvOverrides(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const next = structuredClone(raw);
  for (const assignment of ENV_ASSIGNMENTS) {
    const value = assignment.read(env);
    if (value === undefined) continue;
    setPath(next, assignment.path, value);
  }
  for (const key of ["server", "database", "paths", "auth", "llm", "library", "radio", "acquisition"]) {
    if (!next[key] || typeof next[key] !== "object" || Array.isArray(next[key])) next[key] = {};
  }
  return next;
}

/** Source of each reported setting. Env wins over a yaml key. Secrets are not included. */
export function fieldSourcesFor(rawYaml: unknown, env: NodeJS.ProcessEnv): FieldSources {
  const pinned = new Map<string, string>();
  for (const assignment of ENV_ASSIGNMENTS) {
    if (assignment.read(env) !== undefined) pinned.set(assignment.path, assignment.env);
  }
  const sources: FieldSources = {};
  for (const path of REPORTED_SETTING_PATHS) {
    const envName = pinned.get(path);
    if (envName) sources[path] = { source: "env", env: envName };
    else if (hasOwnPath(rawYaml, path)) sources[path] = { source: "yaml" };
    else sources[path] = { source: "default" };
  }
  return sources;
}

/**
 * Reject a config patch that would change a value pinned by the environment.
 * Sending the current value is not a change.
 */
export function assertEnvPinnedUnchanged(config: { field_sources?: FieldSources }, patch: unknown): void {
  const sources = config.field_sources ?? {};
  for (const [path, meta] of Object.entries(sources)) {
    if (meta.source !== "env" || !meta.env) continue;
    if (!hasOwnPath(patch, path)) continue;
    if (sameSetting(valueAt(config, path), valueAt(patch, path))) continue;
    throw new EnvPinnedError(path, meta.env);
  }
}
