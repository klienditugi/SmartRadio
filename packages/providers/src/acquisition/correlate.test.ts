import { describe, expect, it } from "vitest";
import {
  findCorrelatedTransfer,
  isTransferErrored,
  isTransferInProgress,
  isTransferSucceeded,
  observedTransferId,
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

  it("prefers the exact original filename over another file with the same basename", () => {
    const snapshot = [
      {
        username: "peer-a",
        filename: "\\\\elsewhere\\\\a.flac",
        size: 20_000_000,
        state: "Completed, Succeeded",
        id: "decoy",
      },
      {
        username: "peer-a",
        filename: "\\\\music\\\\a.flac",
        size: 20_000_000,
        state: "InProgress",
        id: "exact",
      },
    ];
    expect(findCorrelatedTransfer(snapshot, target)?.id).toBe("exact");
  });

  it("does not treat a search file id as a match when no transfer has that id", () => {
    const snapshot = [
      {
        username: "peer-a",
        filename: "\\\\music\\\\a.flac",
        size: 20_000_000,
        state: "InProgress",
        id: "tx-a",
      },
    ];
    expect(findCorrelatedTransfer(snapshot, { ...target, id: "file-id-from-search" })?.id).toBe("tx-a");
  });

  it("rejects an exact filename whose size differs or is missing", () => {
    const wrongSize = [
      { username: "peer-a", filename: "\\\\music\\\\a.flac", size: 1, state: "InProgress", id: "wrong-size" },
    ];
    const missingSize = [
      { username: "peer-a", filename: "\\\\music\\\\a.flac", state: "InProgress", id: "no-size" },
    ];
    expect(findCorrelatedTransfer(wrongSize, target)).toBeNull();
    expect(findCorrelatedTransfer(missingSize, target)).toBeNull();
  });

  it("uses a basename fallback only when one row matches basename and size", () => {
    const unique = [
      {
        username: "peer-a",
        filename: "C:/downloads/a.flac",
        size: 20_000_000,
        state: "Queued",
        id: "base",
      },
    ];
    expect(findCorrelatedTransfer(unique, target)?.id).toBe("base");

    const two = [
      { username: "peer-a", filename: "C:/one/a.flac", size: 20_000_000, state: "Queued", id: "one" },
      { username: "peer-a", filename: "C:/two/a.flac", size: 20_000_000, state: "Queued", id: "two" },
    ];
    expect(findCorrelatedTransfer(two, target)).toBeNull();

    const noSize = [{ username: "peer-a", filename: "a.flac", state: "Queued", id: "nosize" }];
    expect(findCorrelatedTransfer(noSize, target)).toBeNull();

    const wrongUser = [{ username: "other", filename: "a.flac", size: 20_000_000, state: "Queued", id: "other" }];
    expect(findCorrelatedTransfer(wrongUser, target)).toBeNull();
  });
});

describe("observedTransferId", () => {
  const filename = "\\\\music\\\\Album\\\\01 Get Lucky.flac";

  it("reads a transfer id only from an enqueue body that names the same file", () => {
    expect(observedTransferId({ ok: true, status: 201 }, { filename, size: 44 })).toBeUndefined();
    expect(
      observedTransferId(
        { id: "tx-9", filename, size: 44, state: "Queued" },
        { filename, size: 44 },
      ),
    ).toBe("tx-9");
    expect(
      observedTransferId(
        [
          { id: "a", filename, size: 44, state: "Queued" },
          { id: "b", filename, size: 44, state: "Queued" },
        ],
        { filename, size: 44 },
      ),
    ).toBeUndefined();
    expect(
      observedTransferId({ id: "tx-9", filename: filename.replaceAll("\\", "/"), size: 44 }, { filename, size: 44 }),
    ).toBeUndefined();
  });
});
