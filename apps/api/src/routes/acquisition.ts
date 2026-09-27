import type { FastifyInstance } from "fastify";
import { acquisitionLiveProbeDecision, probeSlskdConnection, type SlskdProbeChecks } from "@subwave-ai/providers";
import {
  CONFIGURED_UNVERIFIED_MESSAGE,
  SECRET_FILES,
  normalizeAcquisitionSettingsPatch,
  writeSecretFile,
  type AppConfigPatch,
  type RuntimeConfig,
  type VerifyStatus,
} from "@subwave-ai/shared";
import { commitConfigPatch, matchingIntegrationCheck, recordIntegrationProbe } from "../context.js";
import { requireAdmin } from "./auth.js";

const VERIFY_REJECTED = "verify_status cannot be set to verified by saving settings; use test-connection";

type SettingsBody = {
  enabled?: boolean;
  provider?: string;
  base_url?: string;
  verify_status?: VerifyStatus;
  paths?: { downloads?: string; library?: string };
  slskd_api_key?: string;
  username?: unknown;
  password?: unknown;
  soulseek_username?: unknown;
  soulseek_password?: unknown;
  slskd_username?: unknown;
  slskd_password?: unknown;
};

export function acquisitionSettingsView(config: RuntimeConfig) {
  return {
    enabled: config.acquisition.enabled,
    provider: config.acquisition.provider,
    base_url: config.acquisition.base_url,
    verify_status: config.acquisition.verify_status,
    paths: {
      downloads: config.paths.downloads,
      library: config.paths.library,
    },
    secrets_present: {
      slskd_api_key: Boolean(config.secrets.slskdApiKey?.trim()),
    },
  };
}

function rejectsSoulseekCredentials(body: SettingsBody): boolean {
  return (
    body.username !== undefined ||
    body.password !== undefined ||
    body.soulseek_username !== undefined ||
    body.soulseek_password !== undefined ||
    body.slskd_username !== undefined ||
    body.slskd_password !== undefined
  );
}

function assertSettingsBody(body: SettingsBody): void {
  if (rejectsSoulseekCredentials(body)) {
    throw new Error("Soulseek username and password are not stored by SmartRadio");
  }
  if (body.verify_status === "verified") throw new Error(VERIFY_REJECTED);
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new Error("enabled must be a boolean");
  if (body.provider !== undefined && (typeof body.provider !== "string" || body.provider.trim().length === 0)) {
    throw new Error("provider must be a non-empty string");
  }
  if (body.base_url !== undefined && typeof body.base_url !== "string") throw new Error("base_url must be a string");
  if (body.slskd_api_key !== undefined) {
    if (typeof body.slskd_api_key !== "string" || body.slskd_api_key.trim().length === 0) {
      throw new Error("slskd_api_key must be a non-empty string when provided");
    }
  }
  if (body.verify_status !== undefined && body.verify_status !== "unverified" && body.verify_status !== "needs_server_inspection") {
    throw new Error("verify_status must be unverified or needs_server_inspection");
  }
  for (const key of ["downloads", "library"] as const) {
    const value = body.paths?.[key];
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
      throw new Error(`paths.${key} must be a non-empty string`);
    }
  }
}

function settingsPatch(config: RuntimeConfig, body: SettingsBody): AppConfigPatch {
  const acquisition: NonNullable<AppConfigPatch["acquisition"]> = {};
  if (body.enabled !== undefined) acquisition.enabled = body.enabled;
  if (body.provider !== undefined) acquisition.provider = body.provider;
  if (body.base_url !== undefined) acquisition.base_url = body.base_url;
  if (body.verify_status !== undefined) acquisition.verify_status = body.verify_status;
  const patch: AppConfigPatch = {
    acquisition: normalizeAcquisitionSettingsPatch(config.acquisition, acquisition, {
      apiKeyChanged: Boolean(body.slskd_api_key?.trim()),
    }),
  };
  if (body.paths?.downloads || body.paths?.library) {
    patch.paths = {};
    if (body.paths.downloads) patch.paths.downloads = body.paths.downloads.trim();
    if (body.paths.library) patch.paths.library = body.paths.library.trim();
  }
  return patch;
}

type ConnectionReport = {
  ok: boolean;
  state: string;
  probed: boolean;
  detail: string;
  checks: SlskdProbeChecks | null;
  settings: ReturnType<typeof acquisitionSettingsView>;
};

async function reportConnection(app: FastifyInstance, mode: "status" | "test"): Promise<ConnectionReport> {
  const decision = acquisitionLiveProbeDecision(
    {
      enabled: app.config.acquisition.enabled,
      provider: app.config.acquisition.provider,
      baseUrl: app.config.acquisition.base_url,
      hasApiKey: Boolean(app.config.secrets.slskdApiKey?.trim()),
    },
    { ignoreEnabled: mode === "test" },
  );
  if (!decision.probe) {
    return {
      ok: false,
      state: decision.state,
      probed: false,
      detail: decision.detail,
      checks: null,
      settings: acquisitionSettingsView(app.config),
    };
  }

  const stored = matchingIntegrationCheck(app.config, app.db, "acquisition");
  if (mode === "status") {
    if (!stored) {
      return {
        ok: false,
        state: "configured_unverified",
        probed: false,
        detail: CONFIGURED_UNVERIFIED_MESSAGE,
        checks: null,
        settings: acquisitionSettingsView(app.config),
      };
    }
    return {
      ok: stored.state === "ready",
      state: stored.state,
      probed: true,
      detail: stored.state === "ready" ? "ready" : stored.state,
      checks: null,
      settings: acquisitionSettingsView(app.config),
    };
  }

  const apiKey = app.config.secrets.slskdApiKey ?? "";
  let probe;
  try {
    probe = await probeSlskdConnection({
      baseUrl: app.config.acquisition.base_url,
      apiKey,
    });
  } catch {
    probe = {
      state: "unreachable" as const,
      detail: "slskd unreachable",
      checks: {
        reachable: false,
        auth_ok: null,
        application_healthy: false,
        soulseek_connected: null,
        soulseek_logged_in: null,
      },
    };
  }
  recordIntegrationProbe(app, "acquisition", probe.state);
  return {
    ok: probe.state === "ready",
    state: probe.state,
    probed: true,
    detail: probe.detail,
    checks: probe.checks,
    settings: acquisitionSettingsView(app.config),
  };
}

export async function registerAcquisitionRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/acquisition/settings",
    { schema: { tags: ["acquisition"] }, preHandler: requireAdmin },
    async () => acquisitionSettingsView(app.config),
  );

  app.put(
    "/acquisition/settings",
    {
      schema: { tags: ["acquisition"], body: { type: "object", additionalProperties: true } },
      preHandler: requireAdmin,
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as SettingsBody;
      try {
        assertSettingsBody(body);
        if (body.slskd_api_key?.trim()) {
          writeSecretFile(app.config.paths.secrets_dir, SECRET_FILES.slskdApiKey, body.slskd_api_key);
        }
        commitConfigPatch(app, settingsPatch(app.config, body));
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      request.log.info(
        { provider: app.config.acquisition.provider, base_url: app.config.acquisition.base_url, enabled: app.config.acquisition.enabled },
        "acquisition settings saved",
      );
      return acquisitionSettingsView(app.config);
    },
  );

  app.get(
    "/acquisition/status",
    { schema: { tags: ["acquisition"] }, preHandler: requireAdmin },
    async () => reportConnection(app, "status"),
  );

  app.post(
    "/acquisition/test-connection",
    { schema: { tags: ["acquisition"] }, preHandler: requireAdmin },
    async (request) => {
      const report = await reportConnection(app, "test");
      request.log.info(
        { state: report.state, probed: report.probed, base_url: app.config.acquisition.base_url },
        "acquisition test-connection",
      );
      return report;
    },
  );
}
