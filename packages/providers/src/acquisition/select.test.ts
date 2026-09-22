import { describe, expect, it } from "vitest";
import { isSearchComplete, selectSearchResult } from "./select.js";

const SAMPLE = {
  id: "search-1",
  isComplete: true,
  state: "Completed",
  responses: [
    {
      username: "peer-b",
      id: "resp-b",
      files: [
        { filename: "\\\\music\\\\b.mp3", size: 1_000_000, extension: "mp3", bitRate: 192, id: 2 },
      ],
    },
    {
      username: "peer-a",
      id: "resp-a",
      files: [
        { filename: "\\\\music\\\\a.flac", size: 20_000_000, extension: "flac", bitRate: 900, id: 1 },
        { filename: "\\\\music\\\\readme.txt", size: 100, extension: "txt", id: 9 },
      ],
    },
  ],
};

describe("selectSearchResult", () => {
  it("picks a usable audio file deterministically (prefer flac / larger)", () => {
    const first = selectSearchResult(SAMPLE, { allowedExtensions: [".flac", ".mp3", ".m4a", ".ogg", ".wav"] });
    const second = selectSearchResult(SAMPLE, { allowedExtensions: [".flac", ".mp3", ".m4a", ".ogg", ".wav"] });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      username: "peer-a",
      filename: "\\\\music\\\\a.flac",
      size: 20_000_000,
      responseId: "resp-a",
      fileId: "1",
      extension: ".flac",
    });
  });

  it("returns null when nothing matches allowed extensions", () => {
    expect(selectSearchResult(SAMPLE, { allowedExtensions: [".wav"] })).toBeNull();
  });

  it("returns null for empty responses", () => {
    expect(selectSearchResult({ isComplete: true, responses: [] })).toBeNull();
  });
});

describe("isSearchComplete", () => {
  it("reads isComplete and Completed state", () => {
    expect(isSearchComplete({ isComplete: true })).toBe(true);
    expect(isSearchComplete({ isComplete: false, state: "InProgress" })).toBe(false);
    expect(isSearchComplete({ state: "Completed" })).toBe(true);
  });
});
