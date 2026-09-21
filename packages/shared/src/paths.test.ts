import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PathTraversalError, isAllowedAudioExtension, safeJoin } from "./paths.js";

describe("safeJoin", () => {
  it("joins inside the root", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sw-root-"));
    const joined = safeJoin(root, "a", "b.flac");
    expect(joined.startsWith(root)).toBe(true);
    expect(joined.endsWith(`${path.sep}a${path.sep}b.flac`)).toBe(true);
  });

  it("rejects .. traversal and absolute segments", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sw-root-"));
    expect(() => safeJoin(root, "..", "etc", "passwd")).toThrow(PathTraversalError);
    expect(() => safeJoin(root, "/etc/passwd")).toThrow(PathTraversalError);
    expect(() => safeJoin(root, "ok\0evil")).toThrow(PathTraversalError);
  });

  it("checks audio extensions from config, not a hidden list in callers", () => {
    expect(isAllowedAudioExtension("track.FLAC", [".flac", ".mp3"])).toBe(true);
    expect(isAllowedAudioExtension("track.exe", [".flac", ".mp3"])).toBe(false);
  });
});
