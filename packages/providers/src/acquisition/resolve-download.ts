import fs from "node:fs";
import path from "node:path";
import { safeJoin } from "@subwave-ai/shared";

export type ResolvedDownload = {
  basename: string;
  absolutePath: string;
  size: number;
};

/** Soulseek remote paths use backslashes; local landing uses the leaf name. */
export function remoteBasename(remoteFilename: string): string {
  const parts = remoteFilename.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? remoteFilename;
}

const INCOMPLETE_SUFFIXES = [".incomplete", ".!qB", ".part"];

function looksIncomplete(basename: string): boolean {
  const lower = basename.toLowerCase();
  return INCOMPLETE_SUFFIXES.some((suffix) => lower.endsWith(suffix.toLowerCase()));
}

/**
 * Resolve the completed file under configured `paths.downloads`.
 * Never invents `{requestId}.bin`. Returns null when missing or incomplete.
 */
export function resolveDownloadedFile(
  downloadsRoot: string,
  remoteFilename: string,
  expectedSize?: number,
): ResolvedDownload | null {
  const basename = remoteBasename(remoteFilename);
  if (!basename || looksIncomplete(basename)) return null;
  let absolutePath: string;
  try {
    absolutePath = safeJoin(downloadsRoot, basename);
  } catch {
    return null;
  }
  if (!fs.existsSync(absolutePath)) return null;
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || stat.size <= 0) return null;
  if (looksIncomplete(path.basename(absolutePath))) return null;
  if (expectedSize !== undefined && expectedSize > 0 && stat.size !== expectedSize) {
    // Size mismatch can mean still writing; treat as not ready.
    return null;
  }
  return { basename, absolutePath, size: stat.size };
}
