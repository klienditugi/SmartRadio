import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SLSKD_DOWNLOADS_DIR } from "@subwave-ai/shared";
import { remoteBasename, resolveDownloadedFile } from "./resolve-download.js";

const FOLDER = "Beatport Top 100 Techno (Peak Time, Driving) April 2025";
const FILE = "Adam Beyer - Don't Go (Original Mix).mp3";
const REMOTE = `\\\\music\\\\${FOLDER}\\\\${FILE}`;

describe("resolveDownloadedFile", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it("uses the last remote folder and keeps backslash separators", () => {
    const dir = tempDir("slskd-beatport-");
    mkdirSync(path.join(dir, FOLDER));
    writeFileSync(path.join(dir, FOLDER, FILE), Buffer.alloc(120));
    const resolved = resolveDownloadedFile(dir, REMOTE, 120);
    expect(resolved).toEqual({
      ok: true,
      file: {
        basename: FILE,
        absolutePath: path.join(dir, FOLDER, FILE),
        size: 120,
      },
    });
    expect(remoteBasename(REMOTE)).toBe(FILE);
  });

  it("does not accept a file that is only the basename under downloads", () => {
    const dir = tempDir("slskd-base-");
    writeFileSync(path.join(dir, "a.flac"), Buffer.alloc(20_000_000));
    const resolved = resolveDownloadedFile(dir, "\\\\music\\\\a.flac", 20_000_000);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toBe("download_not_found");
      expect(resolved.tried).toEqual([path.join(dir, "music", "a.flac")]);
    }
  });

  it("returns the tried path when the file is missing or the size differs", () => {
    const dir = tempDir("slskd-miss-");
    const missing = resolveDownloadedFile(dir, "\\\\music\\\\missing.flac", 100);
    expect(missing).toEqual({
      ok: false,
      error: "download_not_found",
      tried: [path.join(dir, "music", "missing.flac")],
    });
    mkdirSync(path.join(dir, "music"));
    writeFileSync(path.join(dir, "music", "a.flac"), Buffer.alloc(50));
    const wrong = resolveDownloadedFile(dir, "\\\\music\\\\a.flac", 100);
    expect(wrong).toEqual({
      ok: false,
      error: "download_not_found",
      tried: [path.join(dir, "music", "a.flac")],
    });
  });

  it("ignores a same-sized basename copy next to the parent-folder file", () => {
    const dir = tempDir("slskd-both-");
    mkdirSync(path.join(dir, "Album"));
    writeFileSync(path.join(dir, "Album", "track.flac"), Buffer.alloc(100));
    writeFileSync(path.join(dir, "track.flac"), Buffer.alloc(100));
    const resolved = resolveDownloadedFile(dir, "\\\\music\\\\Album\\\\track.flac", 100);
    expect(resolved).toEqual({
      ok: true,
      file: {
        basename: "track.flac",
        absolutePath: path.join(dir, "Album", "track.flac"),
        size: 100,
      },
    });
  });

  it("maps the container downloads dir onto the host downloads path", () => {
    const dir = tempDir("slskd-prefix-");
    expect(DEFAULT_SLSKD_DOWNLOADS_DIR).toBe("/downloads");
    mkdirSync(path.join(dir, FOLDER));
    writeFileSync(path.join(dir, FOLDER, FILE), Buffer.alloc(80));
    const remote = "\\\\peer\\\\Other Folder\\\\track.flac";
    const resolved = resolveDownloadedFile(dir, remote, 80, {
      reportedPath: `/downloads/${FOLDER}/${FILE}`,
      containerDownloadsDir: "/downloads",
    });
    expect(resolved).toEqual({
      ok: true,
      file: {
        basename: FILE,
        absolutePath: path.join(dir, FOLDER, FILE),
        size: 80,
      },
    });
    const missing = resolveDownloadedFile(dir, remote, 80, {
      reportedPath: "/downloads/Album/missing.flac",
      containerDownloadsDir: "/downloads",
    });
    expect(missing).toEqual({
      ok: false,
      error: "download_not_found",
      tried: [path.join(dir, "Album", "missing.flac"), path.join(dir, "Other Folder", "track.flac")],
    });
  });

  it("rejects incomplete suffixes", () => {
    const dir = tempDir("slskd-inc-");
    writeFileSync(path.join(dir, "a.flac.incomplete"), "partial");
    expect(resolveDownloadedFile(dir, "a.flac.incomplete")).toEqual({
      ok: false,
      error: "download_not_found",
      tried: [],
    });
  });
});
