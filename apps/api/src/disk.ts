import { mkdirSync, statfsSync } from "node:fs";
import path from "node:path";
import type { RuntimeConfig } from "@subwave-ai/shared";

export type DiskSnapshot = {
  path: string;
  role: string;
  ok: boolean;
  total_bytes?: number;
  free_bytes?: number;
  used_bytes?: number;
  used_ratio?: number;
  error?: string;
};

export function diskSnapshot(dir: string, role: string): DiskSnapshot {
  try {
    mkdirSync(dir, { recursive: true });
    const s = statfsSync(dir);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return {
      path: dir,
      role,
      ok: true,
      total_bytes: total,
      free_bytes: free,
      used_bytes: total - free,
      used_ratio: total > 0 ? (total - free) / total : 0,
    };
  } catch (err) {
    return { path: dir, role, ok: false, error: (err as Error).message };
  }
}

export function diskReport(config: RuntimeConfig): { volumes: DiskSnapshot[]; ok: boolean } {
  const dbDir = config.database.path === ":memory:" ? config.paths.downloads : path.dirname(path.resolve(config.database.path));
  const volumes = [
    diskSnapshot(config.paths.downloads, "downloads"),
    diskSnapshot(config.paths.staging, "staging"),
    diskSnapshot(config.paths.library, "library"),
    diskSnapshot(dbDir, "database"),
    diskSnapshot(config.paths.secrets_dir, "secrets"),
  ];
  return { volumes, ok: volumes.every((row) => row.ok) };
}
