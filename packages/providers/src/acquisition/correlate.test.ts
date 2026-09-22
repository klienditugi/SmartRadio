import { describe, expect, it } from "vitest";
import {
  findCorrelatedTransfer,
  isTransferErrored,
  isTransferInProgress,
  isTransferSucceeded,
} from "./correlate.js";

describe("transfer state helpers", () => {
  it("requires Completed and Succeeded, rejects Errored", () => {
    expect(isTransferSucceeded("Completed, Succeeded")).toBe(true);
    expect(isTransferSucceeded("Completed, Errored")).toBe(false);
    expect(isTransferSucceeded("InProgress")).toBe(false);
    expect(isTransferErrored("Completed, Errored")).toBe(true);
    expect(isTransferInProgress("InProgress")).toBe(true);
    expect(isTransferInProgress("Completed, Succeeded")).toBe(false);
  });
});

describe("findCorrelatedTransfer", () => {
  const target = {
    username: "peer-a",
    filename: "\\\\music\\\\a.flac",
    size: 20_000_000,
  };

  it("matches username + filename + size and ignores unrelated completed transfers", () => {
    const snapshot = [
      {
        username: "other",
        filename: "\\\\music\\\\other.flac",
        size: 99,
        state: "Completed, Succeeded",
        id: "tx-other",
      },
      {
        username: "peer-a",
        filename: "\\\\music\\\\a.flac",
        size: 20_000_000,
        state: "InProgress",
        percentComplete: 40,
        id: "tx-a",
      },
    ];
    const hit = findCorrelatedTransfer(snapshot, target);
    expect(hit?.id).toBe("tx-a");
    expect(hit?.state).toBe("InProgress");
    expect(hit?.user).toBe("peer-a");
  });

  it("prefers transfer id when present", () => {
    const snapshot = [
      { username: "peer-a", filename: "\\\\music\\\\a.flac", size: 20_000_000, state: "Queued", id: "wrong" },
      { username: "peer-a", filename: "\\\\music\\\\a.flac", size: 20_000_000, state: "Completed, Succeeded", id: "right" },
    ];
    expect(findCorrelatedTransfer(snapshot, { ...target, id: "right" })?.id).toBe("right");
  });

  it("returns null when only unrelated transfers exist", () => {
    const snapshot = [
      { username: "other", filename: "song.mp3", size: 1, state: "Completed, Succeeded", id: "x" },
    ];
    expect(findCorrelatedTransfer(snapshot, target)).toBeNull();
  });
});
