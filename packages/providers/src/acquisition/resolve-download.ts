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

export type ResolveDownloadOptions = {
  /**
   * Absolute path from the transfer JSON, when that payload already includes one.
   * slskd 0.26 `Transfer` has no local path; `filename` is the remote Soulseek path.
   * When this is set, only the mapped file is considered.
   */
  reportedPath?: string;
  /**
   * Container prefix slskd uses (for example `/downloads`). A reported path under
   * this prefix is joined onto `downloadsRoot`. Empty means no rewrite.
   */
  containerPrefix?: string;
};

function remoteParentName(remoteFilename: string): string | undefined {
  const parts = remoteFilename.split(/[/\\]/).filter(Boolean);
  if (parts.length < 2) return undefined;
  const parent = parts[parts.length - 2];
  if (!parent || parent === "." || parent === "..") return undefined;
  return parent;
}

function mapReportedPath(downloadsRoot: string, reportedPath: string, containerPrefix: string | undefined): string | null {
  const normalized = reportedPath.replaceAll("\\", "/");
  const prefix = containerPrefix?.trim().replaceAll("\\", "/").replace(/\/+$/, "") ?? "";
  if (prefix && (normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    const relative = normalized.slice(prefix.length).replace(/^\/+/, "");
    if (!relative) return null;
    try {
      return safeJoin(downloadsRoot, ...relative.split("/").filter(Boolean));
    } catch {
      return null;
    }
  }
  try {
    return assertInsideDownloads(downloadsRoot, reportedPath);
  } catch {
    return null;
  }
}

function assertInsideDownloads(downloadsRoot: string, candidate: string): string {
  const resolvedRoot = path.resolve(downloadsRoot);
  const resolved = path.resolve(candidate);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
    throw new Error("outside downloads");
  }
  return resolved;
}

function consider(absolutePath: string, expectedSize: number, into: ResolvedDownload[]): void {
  if (looksIncomplete(path.basename(absolutePath))) return;
  if (!fs.existsSync(absolutePath)) return;
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || stat.size !== expectedSize) return;
  into.push({ basename: path.basename(absolutePath), absolutePath, size: stat.size });
}

/**
 * Resolve the completed file under configured `paths.downloads`.
 * Never invents `{requestId}.bin` and never globs.
 *
 * When `reportedPath` is set, only that mapped file can match.
 * Otherwise the candidates are `downloads/<remote parent folder>/<basename>`
 * and then `downloads/<basename>`. Exactly one file with the transfer's byte
 * size matches. Zero or several matches return null (`download_not_found`).
 */
export function resolveDownloadedFile(
  downloadsRoot: string,
  remoteFilename: string,
  expectedSize?: number,
  options?: ResolveDownloadOptions,
): ResolvedDownload | null {
  const basename = remoteBasename(remoteFilename);
  if (!basename || looksIncomplete(basename)) return null;
  if (expectedSize === undefined || !(expectedSize > 0)) return null;

  const matches: ResolvedDownload[] = [];
  const reported = options?.reportedPath?.trim();
  if (reported) {
    const mapped = mapReportedPath(downloadsRoot, reported, options?.containerPrefix);
    if (mapped) consider(mapped, expectedSize, matches);
  } else {
    const parent = remoteParentName(remoteFilename);
    if (parent) {
      try {
        consider(safeJoin(downloadsRoot, parent, basename), expectedSize, matches);
      } catch {
        // A parent segment that escapes the downloads root is not a candidate.
      }
    }
    try {
      consider(safeJoin(downloadsRoot, basename), expectedSize, matches);
    } catch {
      return null;
    }
  }

  const unique = new Map<string, ResolvedDownload>();
  for (const match of matches) unique.set(path.resolve(match.absolutePath), match);
  if (unique.size !== 1) return null;
  return [...unique.values()][0] ?? null;
}
