import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { remoteBasename, resolveDownloadedFile } from "./resolve-download.js";

describe("resolveDownloadedFile", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it("resolves the real basename under paths.downloads", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "slskd-dl-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, "a.flac"), Buffer.alloc(20_000_000));
    const resolved = resolveDownloadedFile(dir, "\\\\music\\\\a.flac", 20_000_000);
    expect(resolved).toEqual({
      basename: "a.flac",
      absolutePath: path.join(dir, "a.flac"),
      size: 20_000_000,
    });
    expect(remoteBasename("\\\\music\\\\a.flac")).toBe("a.flac");
  });

  it("returns null when the downloaded file is missing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "slskd-miss-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(dir, { recursive: true });
    expect(resolveDownloadedFile(dir, "\\\\music\\\\missing.flac", 100)).toBeNull();
  });

  it("resolves a file under the remote parent folder", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "slskd-parent-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, "Album"));
    writeFileSync(path.join(dir, "Album", "track.flac"), Buffer.alloc(100));
    expect(resolveDownloadedFile(dir, "\\\\music\\\\Album\\\\track.flac", 100)).toEqual({
      basename: "track.flac",
      absolutePath: path.join(dir, "Album", "track.flac"),
      size: 100,
    });
  });

  it("returns null when the parent folder and the basename both match the size", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "slskd-both-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, "Album"));
    writeFileSync(path.join(dir, "Album", "track.flac"), Buffer.alloc(100));
    writeFileSync(path.join(dir, "track.flac"), Buffer.alloc(100));
    expect(resolveDownloadedFile(dir, "\\\\music\\\\Album\\\\track.flac", 100)).toBeNull();
  });

  it("returns null when the only candidate has the wrong size", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "slskd-size-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, "a.flac"), Buffer.alloc(50));
    expect(resolveDownloadedFile(dir, "\\\\music\\\\a.flac", 100)).toBeNull();
  });

  it("maps a container path prefix onto the downloads root", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "slskd-prefix-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, "Album"));
    writeFileSync(path.join(dir, "Album", "track.flac"), Buffer.alloc(80));
    const resolved = resolveDownloadedFile(dir, "/downloads/Album/track.flac", 80, {
      reportedPath: "/downloads/Album/track.flac",
      containerPrefix: "/downloads",
    });
    expect(resolved?.absolutePath).toBe(path.join(dir, "Album", "track.flac"));
    writeFileSync(path.join(dir, "track.flac"), Buffer.alloc(80));
    expect(
      resolveDownloadedFile(dir, "/downloads/Album/missing.flac", 80, {
        reportedPath: "/downloads/Album/missing.flac",
        containerPrefix: "/downloads",
      }),
    ).toBeNull();
  });

  it("rejects incomplete suffixes", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "slskd-inc-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, "a.flac.incomplete"), "partial");
    expect(resolveDownloadedFile(dir, "a.flac.incomplete")).toBeNull();
  });
});
