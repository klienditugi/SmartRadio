import fs from "node:fs";
import { loadConfig } from "@subwave-ai/shared";
import { openDatabase } from "@subwave-ai/db";
import { buildApp } from "./app.js";

function ensureDirs(paths: string[]): void {
  for (const dir of paths) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  ensureDirs([
    config.paths.downloads,
    config.paths.staging,
    config.paths.library,
    config.paths.secrets_dir,
  ]);
  const db = openDatabase(config.database.path);
  const app = await buildApp({ config, db, logger: true });
  const host = config.server.host || "127.0.0.1";
  await app.listen({ host, port: config.server.port });
  app.log.info({ host, port: config.server.port }, "subwave-ai api listening");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
