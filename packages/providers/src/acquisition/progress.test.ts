import { describe, expect, it } from "vitest";
import { extractTransferProgress } from "./progress.js";

describe("extractTransferProgress", () => {
  it("reads percentComplete when present without inventing extra endpoints", () => {
    const rows = extractTransferProgress({
      downloads: [
        { username: "peer", filename: "track.flac", percentComplete: 42, state: "InProgress", size: 1000, bytesTransferred: 420 },
      ],
    });
    const match = rows.find((row) => row.filename === "track.flac");
    expect(match?.user).toBe("peer");
    expect(match?.progress).toBeCloseTo(0.42);
    expect(match?.status).toBe("InProgress");
  });

  it("ignores unrelated objects", () => {
    expect(extractTransferProgress({ hello: "world" })).toEqual([]);
  });
});
