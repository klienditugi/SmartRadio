import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type RuntimeConfig } from "@subwave-ai/shared";
import { openDatabase, type Db } from "@subwave-ai/db";

export function testConfig(): { config: RuntimeConfig; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-api-"));
  const secrets = path.join(dir, "secrets");
  mkdirSync(secrets);
  writeFileSync(path.join(secrets, "admin_password"), "test-admin-password");
  writeFileSync(path.join(secrets, "session_secret"), "test-session-secret");
  const cfgPath = path.join(dir, "subwave.yaml");
  writeFileSync(
    cfgPath,
    `
server:
  host: "127.0.0.1"
  port: 8788
database:
  path: ":memory:"
paths:
  secrets_dir: "${secrets}"
  downloads: "${path.join(dir, "downloads")}"
  staging: "${path.join(dir, "staging")}"
  library: "${path.join(dir, "library")}"
llm:
  base_url: "http://127.0.0.1:11434"
  model: "test-model"
library:
  base_url: "http://navidrome.example"
  username: "nd"
radio:
  base_url: "http://radio.example/api"
  admin_user: "dj"
acquisition:
  provider: slskd
  base_url: "http://slskd.example"
`,
  );
  const prevConfig = process.env.SUBWAVE_CONFIG;
  process.env.SUBWAVE_CONFIG = cfgPath;
  const config = loadConfig({ configPath: cfgPath });
  return {
    config,
    dir,
    cleanup: () => {
      if (prevConfig === undefined) delete process.env.SUBWAVE_CONFIG;
      else process.env.SUBWAVE_CONFIG = prevConfig;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function testDb(config: RuntimeConfig): Db {
  return openDatabase(config.database.path);
}
