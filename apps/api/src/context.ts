import type { FastifyInstance } from "fastify";
import {
  countUsers,
  insertUser,
  listProviders,
  listSettings,
  openDatabase,
  putSetting,
  upsertProvider,
  type Db,
} from "@subwave-ai/db";
import { publicSettings, type RuntimeConfig } from "@subwave-ai/shared";
import { hashPassword } from "./auth.js";

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
  upsertProvider(db, {
    id: "acquisition-slskd",
    kind: "acquisition",
    name: "SoulseekProvider",
    verifyStatus: config.acquisition.verify_status,
    config: { base_url: config.acquisition.base_url, provider: "slskd" },
  });
}

export function doctorReport(db: Db, config: RuntimeConfig) {
  let dbOk = true;
  try {
    db.prepare("SELECT 1").get();
  } catch {
    dbOk = false;
  }
  return {
    ok: dbOk && Boolean(config.llm.model),
    database: dbOk,
    bind: { host: config.server.host, port: config.server.port },
    ollama: "external-only",
    config: publicSettings(config),
    settings: listSettings(db),
    providers: listProviders(db),
    notes: [
      "API is sync+enqueue only. Workers own LLM, library, acquisition, radio, and live health probes.",
      "Ollama is never installed, updated, or pulled by this process.",
      "Live URLs/credentials are placeholders unless provided via yaml/env/secrets.",
    ],
  };
}

export { putSetting, openDatabase };
