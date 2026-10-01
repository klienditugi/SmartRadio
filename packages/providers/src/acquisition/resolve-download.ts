import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SLSKD_DOWNLOADS_DIR, safeJoin } from "@subwave-ai/shared";

export type ResolvedDownload = {
  basename: string;
  absolutePath: string;
  size: number;
};

/** Soulseek remote paths use backslashes; the leaf is the file name. */
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
   * Local path from the completed transfer, only when that payload already has one.
   * slskd 0.26 `Transfer` has no such field (`filename` is the remote path).
   */
  reportedPath?: string;
  /**
   * Downloads directory as slskd sees it. Default `/downloads`.
   * A reported path under this prefix is joined onto `downloadsRoot`.
   */
  containerDownloadsDir?: string;
};

export type ResolveDownloadResult =
  | { ok: true; file: ResolvedDownload }
  | { ok: false; error: "download_not_found"; tried: string[] };

function remoteParts(remoteFilename: string): string[] {
  return remoteFilename.split(/[/\\]/).filter(Boolean);
}

/** `paths.downloads/<last remote folder>/<basename>`. No bare-basename candidate. */
function layoutCandidate(downloadsRoot: string, remoteFilename: string): string | null {
  const parts = remoteParts(remoteFilename);
  if (parts.length < 2) return null;
  const basename = parts[parts.length - 1] ?? "";
  const parent = parts[parts.length - 2] ?? "";
  if (!basename || looksIncomplete(basename)) return null;
  if (!parent || parent === "." || parent === "..") return null;
  try {
    return safeJoin(downloadsRoot, parent, basename);
  } catch {
    return null;
  }
}

function mapContainerPath(downloadsRoot: string, reportedPath: string, containerDownloadsDir: string): string | null {
  const normalized = reportedPath.replaceAll("\\", "/");
  const prefix = containerDownloadsDir.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (prefix && (normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    const relative = normalized.slice(prefix.length).replace(/^\/+/, "");
    if (!relative) return null;
    try {
      return safeJoin(downloadsRoot, ...relative.split("/").filter(Boolean));
    } catch {
      return null;
    }
  }
  const resolvedRoot = path.resolve(downloadsRoot);
  const resolved = path.resolve(reportedPath);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolved === resolvedRoot || resolved.startsWith(rootPrefix)) return resolved;
  return null;
}

function exactFile(absolutePath: string, expectedSize: number): ResolvedDownload | null {
  if (looksIncomplete(path.basename(absolutePath))) return null;
  if (!fs.existsSync(absolutePath)) return null;
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || stat.size !== expectedSize) return null;
  return { basename: path.basename(absolutePath), absolutePath, size: stat.size };
}

/**
 * Resolve one completed download.
 *
 * 1. Map a reported local path from the container downloads dir onto `downloadsRoot`,
 *    when the caller has one. The current slskd transfer type does not.
 * 2. Otherwise, and also when that mapped path is not the file,
 *    `downloadsRoot/<last folder of the remote path>/<basename>`.
 *
 * Exact byte size only. No basename search and no glob. Zero or several matches
 * is `download_not_found`, with every path that was considered.
 */
export function resolveDownloadedFile(
  downloadsRoot: string,
  remoteFilename: string,
  expectedSize?: number,
  options?: ResolveDownloadOptions,
): ResolveDownloadResult {
  const basename = remoteBasename(remoteFilename);
  if (!basename || looksIncomplete(basename)) {
    return { ok: false, error: "download_not_found", tried: [] };
  }

  const containerDir = options?.containerDownloadsDir?.trim() || DEFAULT_SLSKD_DOWNLOADS_DIR;
  const tried: string[] = [];
  const reported = options?.reportedPath?.trim();
  if (reported) {
    const mapped = mapContainerPath(downloadsRoot, reported, containerDir);
    if (mapped) tried.push(mapped);
  }
  const layout = layoutCandidate(downloadsRoot, remoteFilename);
  if (layout) {
    const resolvedLayout = path.resolve(layout);
    if (!tried.some((candidate) => path.resolve(candidate) === resolvedLayout)) tried.push(layout);
  }

  if (expectedSize === undefined || !(expectedSize > 0)) {
    return { ok: false, error: "download_not_found", tried };
  }

  const matches: ResolvedDownload[] = [];
  for (const candidate of tried) {
    const file = exactFile(candidate, expectedSize);
    if (file) matches.push(file);
  }
  if (matches.length !== 1) return { ok: false, error: "download_not_found", tried };
  return { ok: true, file: matches[0]! };
}
