import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadSecrets, type LoadedSecrets } from "./secrets.js";

const envString = z.string().min(1);

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
  llm: z.object({
    provider: z.literal("ollama").default("ollama"),
    base_url: envString,
    model: z.string().min(1),
    timeout_ms: z.number().int().positive().default(120_000),
    verify_status: z.enum(["verified", "unverified", "needs_server_inspection"]).default("verified"),
  }),
  library: z.object({
    provider: z.literal("navidrome").default("navidrome"),
    base_url: z.string().min(1),
    username: z.string().min(1),
    client_name: z.string().min(1).default("subwave-ai"),
    api_version: z.string().min(1).default("1.16.1"),
    verify_status: z.enum(["verified", "unverified", "needs_server_inspection"]).default("verified"),
  }),
  radio: z.object({
    provider: z.literal("subwave").default("subwave"),
    base_url: z.string().min(1),
    admin_user: z.string().min(1),
    verify_status: z.enum(["verified", "unverified", "needs_server_inspection"]).default("verified"),
  }),
  acquisition: z.object({
    provider: z.literal("slskd"),
    base_url: z.string().min(1),
    verify_status: z.enum(["verified", "unverified", "needs_server_inspection"]).default("verified"),
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
  if (env.OLLAMA_BASE_URL) set(llm, "base_url", env.OLLAMA_BASE_URL);
  if (env.OLLAMA_MODEL) set(llm, "model", env.OLLAMA_MODEL);
  next.llm = llm;

  const library = (next.library ?? {}) as Record<string, unknown>;
  if (env.NAVIDROME_URL) set(library, "base_url", env.NAVIDROME_URL);
  if (env.NAVIDROME_USER) set(library, "username", env.NAVIDROME_USER);
  next.library = library;

  const radio = (next.radio ?? {}) as Record<string, unknown>;
  if (env.SUBWAVE_RADIO_URL) set(radio, "base_url", env.SUBWAVE_RADIO_URL);
  if (env.SUBWAVE_RADIO_ADMIN_USER) set(radio, "admin_user", env.SUBWAVE_RADIO_ADMIN_USER);
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

function resolveConfigPath(env: NodeJS.ProcessEnv, explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (env.SUBWAVE_CONFIG) return path.resolve(env.SUBWAVE_CONFIG);
  const local = path.resolve(process.cwd(), "config/subwave.yaml");
  if (existsSync(local)) return local;
  return path.resolve(process.cwd(), "config/subwave.example.yaml");
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
  let parsed: AppConfig;
  try {
    parsed = parseAppConfig(overridden);
  } catch (err) {
    const llm = (overridden.llm ?? {}) as { model?: string };
    if (!llm.model) {
      throw new Error(
        "LLM model is not configured. Set OLLAMA_MODEL (or llm.model in yaml) to a model already present on the external Ollama host. This app never defaults or pulls a model name.",
      );
    }
    throw err;
  }
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
      provider: config.acquisition.provider,
      base_url: config.acquisition.base_url,
      verify_status: config.acquisition.verify_status,
    },
    secrets_present: {
      admin_password: Boolean(config.secrets.adminPassword),
      session_secret: Boolean(config.secrets.sessionSecret),
      navidrome_password: Boolean(config.secrets.navidromePassword),
      subwave_admin_password: Boolean(config.secrets.subwaveAdminPassword),
      slskd_api_key: Boolean(config.secrets.slskdApiKey),
    },
  };
}
