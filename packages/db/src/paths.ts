import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function resolveMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "migrations"), path.join(here, "../src/migrations")];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  throw new Error("migrations directory not found");
}

export { resolveMigrationsDir };
