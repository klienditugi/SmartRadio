import fs from "node:fs";
import { loadConfig } from "@subwave-ai/shared";
import { openDatabase } from "@subwave-ai/db";
import { createProviders } from "@subwave-ai/providers";
import { claimAndRun } from "./dispatch.js";
import type { WorkerContext } from "./context.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = loadConfig();
  fs.mkdirSync(config.paths.downloads, { recursive: true });
  fs.mkdirSync(config.paths.staging, { recursive: true });
  fs.mkdirSync(config.paths.library, { recursive: true });
  const db = openDatabase(config.database.path);
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
