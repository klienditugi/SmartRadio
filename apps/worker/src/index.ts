import fs from "node:fs";
import { applyStoredVerification, loadConfig } from "@subwave-ai/shared";
import { listIntegrationChecks, openDatabase } from "@subwave-ai/db";
import { createProviders } from "@subwave-ai/providers";
import { claimAndRun } from "./dispatch.js";
import type { WorkerContext } from "./context.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const loaded = loadConfig();
  fs.mkdirSync(loaded.paths.downloads, { recursive: true });
  fs.mkdirSync(loaded.paths.staging, { recursive: true });
  fs.mkdirSync(loaded.paths.library, { recursive: true });
  const db = openDatabase(loaded.database.path);
  const config = applyStoredVerification(loaded, listIntegrationChecks(db));
  const ctx: WorkerContext = {
    db,
    config,
    providers: createProviders(config),
    workerId: config.worker.id,
  };
  let running = true;
  process.on("SIGINT", () => {
    running = false;
  });
  process.on("SIGTERM", () => {
    running = false;
  });
  console.log(`subwave-ai worker ${ctx.workerId} polling jobs`);
  while (running) {
    const did = await claimAndRun(ctx);
    if (!did) await sleep(config.worker.poll_ms);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
