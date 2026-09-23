import type { FastifyInstance } from "fastify";
import {
  SECRET_FILES,
  loadConfig,
  mergeAppConfigPatch,
  nextAcquisitionConfig,
  withAcquisitionVerifyStatus,
  writableConfigPath,
  writeAppConfig,
  writeSecretFile,
  type AppConfigPatch,
  type RuntimeConfig,
} from "@subwave-ai/shared";
import { replaceRuntimeConfig, syncProviders } from "../context.js";
import { assessAcquisition, type AcquisitionProbeResult } from "../acquisition-probe.js";
import { requireAdmin, requireUser } from "./auth.js";

/**
 * UI contract for acquisition setup (A6 phases B+C).
 *
 * Bot2 owns the canonical backend if that branch lands separately. Keep these paths and fields:
 *   GET  /api/v1/acquisition/settings
 *   PUT  /api/v1/acquisition/settings
 *   POST /api/v1/acquisition/test-connection
 *   GET  /api/v1/acquisition/status
 *
 * `state` is one of: disabled, not_configured, unreachable, auth_failed, reachable,
 * soulseek_not_connected, soulseek_not_logged_in, ready.
 * POST test-connection is the only route that may set verify_status to verified, and only
 * after GET /api/v0/application and GET /api/v0/server show Soulseek connected and logged in.
 * The API key is write-only (`secrets/slskd_api_key`) and is never returned or logged.
 * These routes do not search or enqueue downloads.
 */

const SUPPORTED_PROVIDERS = ["slskd"] as const;

type SettingsBody = {
  enabled?: boolean;
  provider?: string;
  base_url?: string;
  downloads?: string;
  library?: string;
  api_key?: string;
  verify_status?: unknown;
};

export function publicAcquisitionSettings(config: RuntimeConfig) {
  return {
    enabled: config.acquisition.enabled,
    provider: config.acquisition.provider,
    base_url: config.acquisition.base_url,
    downloads: config.paths.downloads,
    library: config.paths.library,
    api_key_configured: Boolean(config.secrets.slskdApiKey),
    verify_status: config.acquisition.verify_status,
    supported_providers: SUPPORTED_PROVIDERS,
  };
}

function statusPayload(config: RuntimeConfig, probe: AcquisitionProbeResult, workerReloadRequired = false) {
  return {
    state: probe.state,
    verify_status: config.acquisition.verify_status,
    detail: probe.detail,
    checked_at: probe.checked_at,
    api_key_configured: Boolean(config.secrets.slskdApiKey),
    worker_reload_required: workerReloadRequired,
  };
}

function validateBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "slskd URL must be an absolute http(s) URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "slskd URL must be an absolute http(s) URL";
  if (url.username || url.password) return "slskd URL must not include credentials";
  return null;
}

function reload(app: FastifyInstance): void {
  const reloaded = loadConfig({ configPath: writableConfigPath() });
  replaceRuntimeConfig(app, reloaded);
  syncProviders(app.db, app.config);
}

export async function registerAcquisitionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/acquisition/settings", { schema: { tags: ["settings"] }, preHandler: requireUser }, async () => {
    return publicAcquisitionSettings(app.config);
  });

  app.put(
    "/acquisition/settings",
    {
      schema: { tags: ["settings"], body: { type: "object", additionalProperties: true } },
      preHandler: requireAdmin,
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as SettingsBody;
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        return reply.code(400).send({ error: "enabled must be a boolean" });
      }
      if (body.provider !== undefined && (typeof body.provider !== "string" || !body.provider.trim())) {
        return reply.code(400).send({ error: "provider must be a non-empty string" });
      }
      if (body.base_url !== undefined && typeof body.base_url !== "string") {
        return reply.code(400).send({ error: "base_url must be a string" });
      }
      if (typeof body.base_url === "string") {
        const urlError = validateBaseUrl(body.base_url);
        if (urlError) return reply.code(400).send({ error: urlError });
      }
      if (body.downloads !== undefined && (typeof body.downloads !== "string" || !body.downloads.trim())) {
        return reply.code(400).send({ error: "downloads must be a non-empty path" });
      }
      if (body.library !== undefined && (typeof body.library !== "string" || !body.library.trim())) {
        return reply.code(400).send({ error: "library must be a non-empty path" });
      }
      if (body.api_key !== undefined && typeof body.api_key !== "string") {
        return reply.code(400).send({ error: "api_key must be a string" });
      }
      const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
      if (apiKey && (apiKey.length < 16 || apiKey.length > 255)) {
        return reply.code(400).send({ error: "slskd API key must be 16–255 characters" });
      }

      if (apiKey) writeSecretFile(app.config.paths.secrets_dir, SECRET_FILES.slskdApiKey, apiKey);
      const acquisition = nextAcquisitionConfig(
        app.config.acquisition,
        {
          enabled: body.enabled,
          provider: typeof body.provider === "string" ? body.provider : undefined,
          base_url: typeof body.base_url === "string" ? body.base_url : undefined,
        },
        Boolean(apiKey),
      );
      const patch: AppConfigPatch = {
        acquisition: {
          enabled: acquisition.enabled,
          provider: acquisition.provider,
          base_url: acquisition.base_url,
        },
        paths: {
          ...(typeof body.downloads === "string" ? { downloads: body.downloads.trim() } : {}),
          ...(typeof body.library === "string" ? { library: body.library.trim() } : {}),
        },
      };
      const merged = withAcquisitionVerifyStatus(mergeAppConfigPatch(app.config, patch), acquisition.verify_status);
      writeAppConfig(writableConfigPath(), merged);
      reload(app);
      return publicAcquisitionSettings(app.config);
    },
  );

  app.get("/acquisition/status", { schema: { tags: ["settings"] }, preHandler: requireUser }, async () => {
    const probe = await assessAcquisition(app.config);
    return statusPayload(app.config, probe, false);
  });

  app.post(
    "/acquisition/test-connection",
    { schema: { tags: ["settings"] }, preHandler: requireAdmin },
    async () => {
      const before = app.config.acquisition.verify_status;
      const probe = await assessAcquisition(app.config);
      const next = probe.state === "ready" ? "verified" : "unverified";
      let workerReloadRequired = false;
      if (next !== before) {
        const merged = withAcquisitionVerifyStatus(app.config, next);
        writeAppConfig(writableConfigPath(), merged);
        reload(app);
        workerReloadRequired = true;
      }
      return statusPayload(app.config, probe, workerReloadRequired);
    },
  );
}
