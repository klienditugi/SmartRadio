import type { FastifyInstance } from "fastify";
import {
  probeNavidromeConnection,
  probeOllamaConnection,
  probeSubwaveConnection,
  type IntegrationProbe,
} from "@subwave-ai/providers";
import {
  CONFIGURED_UNVERIFIED_MESSAGE,
  integrationIsConfigured,
  type CoreIntegration,
  type RuntimeConfig,
} from "@subwave-ai/shared";
import { matchingIntegrationCheck, recordIntegrationProbe } from "../context.js";
import { requireAdmin } from "./auth.js";

type ConnectionReport = {
  ok: boolean;
  state: string;
  probed: boolean;
  detail: string;
  settings: ReturnType<typeof integrationSettingsView>;
};

export function integrationSettingsView(config: RuntimeConfig, kind: CoreIntegration) {
  if (kind === "llm") {
    return {
      provider: config.llm.provider,
      base_url: config.llm.base_url,
      model: config.llm.model,
      verify_status: config.llm.verify_status,
      verify_status_explicit: config.verify_status_explicit?.llm === true,
    };
  }
  if (kind === "library") {
    return {
      provider: config.library.provider,
      base_url: config.library.base_url,
      username: config.library.username,
      verify_status: config.library.verify_status,
      verify_status_explicit: config.verify_status_explicit?.library === true,
      secrets_present: { navidrome_password: Boolean(config.secrets.navidromePassword?.trim()) },
    };
  }
  return {
    provider: config.radio.provider,
    base_url: config.radio.base_url,
    admin_user: config.radio.admin_user,
    verify_status: config.radio.verify_status,
    verify_status_explicit: config.verify_status_explicit?.radio === true,
    secrets_present: { subwave_admin_password: Boolean(config.secrets.subwaveAdminPassword?.trim()) },
  };
}

function notConfiguredDetail(kind: CoreIntegration): string {
  if (kind === "llm") return "Ollama is missing base_url or model";
  if (kind === "library") return "Navidrome is missing base_url, username, or password";
  return "SUB/WAVE is missing base_url, admin user, or password";
}

async function probe(config: RuntimeConfig, kind: CoreIntegration): Promise<IntegrationProbe> {
  if (kind === "llm") {
    return probeOllamaConnection({ baseUrl: config.llm.base_url, model: config.llm.model });
  }
  if (kind === "library") {
    return probeNavidromeConnection({
      baseUrl: config.library.base_url,
      username: config.library.username,
      password: config.secrets.navidromePassword ?? "",
      clientName: config.library.client_name,
      apiVersion: config.library.api_version,
    });
  }
  return probeSubwaveConnection({
    baseUrl: config.radio.base_url,
    adminUser: config.radio.admin_user,
    adminPassword: config.secrets.subwaveAdminPassword ?? "",
  });
}

async function reportConnection(app: FastifyInstance, kind: CoreIntegration, mode: "status" | "test"): Promise<ConnectionReport> {
  const configured = integrationIsConfigured(app.config, kind);
  if (!configured) {
    return {
      ok: false,
      state: "not_configured",
      probed: false,
      detail: notConfiguredDetail(kind),
      settings: integrationSettingsView(app.config, kind),
    };
  }
  const stored = matchingIntegrationCheck(app.config, app.db, kind);
  if (mode === "status") {
    if (!stored) {
      return {
        ok: false,
        state: "configured_unverified",
        probed: false,
        detail: CONFIGURED_UNVERIFIED_MESSAGE,
        settings: integrationSettingsView(app.config, kind),
      };
    }
    return {
      ok: stored.state === "ready",
      state: stored.state,
      probed: true,
      detail: stored.state === "ready" ? "ready" : stored.state,
      settings: integrationSettingsView(app.config, kind),
    };
  }

  let result: IntegrationProbe;
  try {
    result = await probe(app.config, kind);
  } catch {
    result = { state: "unreachable", detail: notConfiguredDetail(kind) };
  }
  recordIntegrationProbe(app, kind, result.state);
  return {
    ok: result.state === "ready",
    state: result.state,
    probed: true,
    detail: result.detail,
    settings: integrationSettingsView(app.config, kind),
  };
}

function registerKind(app: FastifyInstance, kind: CoreIntegration): void {
  app.get(
    `/${kind}/status`,
    { schema: { tags: [kind] }, preHandler: requireAdmin },
    async () => reportConnection(app, kind, "status"),
  );
  app.post(
    `/${kind}/test-connection`,
    { schema: { tags: [kind] }, preHandler: requireAdmin },
    async (request) => {
      const report = await reportConnection(app, kind, "test");
      request.log.info({ integration: kind, state: report.state, probed: report.probed }, "integration test-connection");
      return report;
    },
  );
}

export async function registerIntegrationRoutes(app: FastifyInstance): Promise<void> {
  registerKind(app, "llm");
  registerKind(app, "library");
  registerKind(app, "radio");
}
