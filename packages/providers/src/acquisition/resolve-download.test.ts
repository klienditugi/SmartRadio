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

  it("rejects incomplete suffixes", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "slskd-inc-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, "a.flac.incomplete"), "partial");
    expect(resolveDownloadedFile(dir, "a.flac.incomplete")).toBeNull();
  });
});
