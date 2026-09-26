import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  countUsers,
  getSetting,
  putSetting,
} from "@subwave-ai/db";
import {
  SECRET_FILES,
  assertSettingsDoNotVerify,
  clearIntegrationVerifyOnChange,
  normalizeAcquisitionSettingsPatch,
  publicSettings,
  writeSecretFile,
  type AppConfigPatch,
} from "@subwave-ai/shared";
import { hashPassword } from "../auth.js";
import { commitConfigPatch, commitRuntimeConfig, seedAdmin } from "../context.js";
import { requireAdmin } from "./auth.js";

type SetupSecrets = {
  admin_password?: string;
  session_secret?: string;
  navidrome_password?: string;
  subwave_admin_password?: string;
  slskd_api_key?: string;
};

type SetupBody = {
  config?: AppConfigPatch;
  secrets?: SetupSecrets;
  setup_complete?: boolean;
};

function setupGaps(app: FastifyInstance) {
  const pub = publicSettings(app.config);
  const missing: string[] = [];
  if (countUsers(app.db) === 0) missing.push("admin_user");
  if (!pub.secrets_present.admin_password) missing.push("admin_password");
  if (!pub.secrets_present.session_secret) missing.push("session_secret");
  if (!app.config.llm.model) missing.push("llm.model");
  if (!app.config.llm.base_url) missing.push("llm.base_url");
  if (!app.config.library.base_url) missing.push("library.base_url");
  if (!app.config.library.username) missing.push("library.username");
  if (!pub.secrets_present.navidrome_password) missing.push("navidrome_password");
  if (!app.config.radio.base_url) missing.push("radio.base_url");
  if (!app.config.radio.admin_user) missing.push("radio.admin_user");
  if (!pub.secrets_present.subwave_admin_password) missing.push("subwave_admin_password");
  if (app.config.acquisition.enabled) {
    if (!app.config.acquisition.base_url.trim()) missing.push("acquisition.base_url");
    if (!pub.secrets_present.slskd_api_key) missing.push("slskd_api_key");
  }
  const setupComplete = Boolean(getSetting(app.db, "setup_complete"));
  return {
    configured: countUsers(app.db) > 0,
    setup_complete: setupComplete,
    missing,
    ollama: "external-only" as const,
    secrets_present: pub.secrets_present,
  };
}

async function applySetup(app: FastifyInstance, body: SetupBody, actor?: string): Promise<void> {
  assertSettingsDoNotVerify(body.config);
  const secretsDir = app.config.paths.secrets_dir;
  const secrets = body.secrets ?? {};
  if (secrets.admin_password) writeSecretFile(secretsDir, SECRET_FILES.adminPassword, secrets.admin_password);
  if (secrets.session_secret) writeSecretFile(secretsDir, SECRET_FILES.sessionSecret, secrets.session_secret);
  if (secrets.navidrome_password) writeSecretFile(secretsDir, SECRET_FILES.navidromePassword, secrets.navidrome_password);
  if (secrets.subwave_admin_password) {
    writeSecretFile(secretsDir, SECRET_FILES.subwaveAdminPassword, secrets.subwave_admin_password);
  }
  const apiKeyChanged = Boolean(secrets.slskd_api_key?.trim());
  if (apiKeyChanged && secrets.slskd_api_key) {
    writeSecretFile(secretsDir, SECRET_FILES.slskdApiKey, secrets.slskd_api_key);
  }

  let patch = body.config ? clearIntegrationVerifyOnChange(app.config, body.config, {
    navidromePassword: Boolean(secrets.navidrome_password?.trim()),
    radioPassword: Boolean(secrets.subwave_admin_password?.trim()),
  }) : body.config;
  if (patch || apiKeyChanged || secrets.navidrome_password || secrets.subwave_admin_password) {
    const acquisition = normalizeAcquisitionSettingsPatch(app.config.acquisition, patch?.acquisition, {
      apiKeyChanged,
    });
    patch = clearIntegrationVerifyOnChange(app.config, { ...(patch ?? {}), acquisition }, {
      navidromePassword: Boolean(secrets.navidrome_password?.trim()),
      radioPassword: Boolean(secrets.subwave_admin_password?.trim()),
    });
  }
  if (patch) commitConfigPatch(app, patch);
  else commitRuntimeConfig(app, app.config);

  if (secrets.admin_password && countUsers(app.db) === 0) {
    await seedAdmin(app.db, app.config);
  } else if (secrets.admin_password) {
    const { findUserByUsername } = await import("@subwave-ai/db");
    const user = findUserByUsername(app.db, app.config.auth.admin_username);
    if (user) {
      const hash = await hashPassword(secrets.admin_password);
      app.db
        .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(hash, Date.now(), user.id);
    } else {
      await seedAdmin(app.db, app.config);
    }
  }

  if (body.setup_complete) {
    putSetting(app.db, "setup_complete", true, actor);
  }
}

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/setup", { schema: { tags: ["settings"] } }, async () => setupGaps(app));

  app.post(
    "/setup",
    {
      schema: {
        tags: ["settings"],
        body: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
    async (request, reply) => {
      const bootstrapping = countUsers(app.db) === 0;
      if (!bootstrapping) {
        await requireAdmin(request, reply);
        if (reply.sent) return;
      }
      const body = (request.body ?? {}) as SetupBody;
      if (bootstrapping) {
        const password = body.secrets?.admin_password;
        if (!password || password.length < 8) {
          return reply.code(400).send({ error: "admin_password is required (min 8 chars) for first-run setup" });
        }
        if (!body.secrets?.session_secret) {
          body.secrets = { ...body.secrets, session_secret: randomBytes(32).toString("hex") };
        }
      }
      try {
        await applySetup(app, body, request.user?.id);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      return {
        ok: true,
        setup: setupGaps(app),
        config: publicSettings(app.config),
        note: "YAML/secrets were written. A process restart picks up bind-address changes. Ollama stays external.",
      };
    },
  );
}
