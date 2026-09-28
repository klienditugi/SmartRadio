/**
 * Selector checks against the sanitized Phase C slskd search.
 * The two fixture files are the cleaned extract. No other dump is committed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectSearch, type SearchSelection, type SelectSearchOptions } from "./select.js";
import { dryRunExplicitRequests, dryRunPreferences, selectorQuery } from "./selector-dryrun.js";

const FIXTURES = new URL("../../../core/test/fixtures/slskd-phase-c/", import.meta.url);
type SlskdFile = { filename: string; size?: number } & Record<string, unknown>;
type SlskdResponse = { username: string; files?: SlskdFile[]; lockedFiles?: unknown[] } & Record<string, unknown>;
type SearchPayload = { responses: SlskdResponse[]; searchText?: string } & Record<string, unknown>;
type TagRow = { username: string; filename: string; tags: string[] };

const curatedUrl = new URL("phase-c-curated.json", FIXTURES);
const tagsUrl = new URL("phase-c-curated-tags.json", FIXTURES);
const curated = JSON.parse(readFileSync(curatedUrl, "utf8")) as SearchPayload & {
  responseCount?: number;
  fileCount?: number;
  lockedFileCount?: number;
};
const tagRows = JSON.parse(readFileSync(tagsUrl, "utf8")) as TagRow[];

const AUDIO = [".mp3", ".flac", ".m4a", ".ogg", ".wav"] as const;
const SONG = { artist: "Daft Punk", title: "Get Lucky" };
const MIB = 1024 * 1024;

function blobSha(url: URL): string {
  const bytes = readFileSync(url);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function only(match: (response: SlskdResponse, file: SlskdFile) => boolean): SearchPayload {
  const responses: SlskdResponse[] = [];
  for (const response of curated.responses) {
    const files = (response.files ?? []).filter((file) => match(response, file));
    if (files.length === 0) continue;
    responses.push({ ...response, files, lockedFiles: [] });
  }
  return { responses, searchText: curated.searchText };
}

function run(payload: unknown, opts: SelectSearchOptions = {}): SearchSelection {
  return selectSearch(payload, { allowedExtensions: AUDIO, query: SONG, ...opts });
}

function reasonCounts(decision: SearchSelection): Record<string, number> {
  if (decision.outcome !== "no_suitable_result" && decision.outcome !== "selected") return {};
  return decision.removed;
}

describe("sanitized Phase C fixtures", () => {
  it("keeps the cleaned curated extract byte-for-byte", () => {
    expect(curated.responses).toHaveLength(38);
    expect(tagRows).toHaveLength(87);
    expect(curated.searchText).toBe("Daft Punk Get Lucky");
    expect(curated.responseCount).toBe(251);
    expect(curated.fileCount).toBe(583);
    expect(curated.lockedFileCount).toBe(33);
    expect(blobSha(curatedUrl)).toBe("17ba873028ddfcc73dc4f22db6fc4d162c3fe96e");
    expect(blobSha(tagsUrl)).toBe("5ff304ba7fb2c7baf62b054c96c3b118fde4ad1c");
    expect(selectorQuery(curated)).toEqual(SONG);
    expect(selectorQuery({ SearchText: "Daft Punk Get Lucky" })).toEqual(SONG);
    expect(selectorQuery({ responses: [] })).toEqual({});
  });
});

describe("curated selector", () => {
  it("picks a remix, club, or extended file at or under 30 MiB when one is available", () => {
    const decision = run(curated);
    expect(decision.outcome).toBe("selected");
    if (decision.outcome !== "selected") return;
    expect(["remix", "extended"]).toContain(decision.versionClass);
    expect(decision.file.size).toBeLessThanOrEqual(30 * MIB);
    expect(decision.breakdown.titleMatch).toBeGreaterThan(0);
    expect(decision.breakdown.artistInPath).toBeGreaterThan(0);
    expect(decision.file.extension).toBe(".mp3");
  });

  it("picks an album or original file when no fun version is left, then a radio edit", () => {
    const originalVsRadio = only(
      (response, file) =>
        (response.username === "peer-001" && file.filename.includes("(Original Mix)")) ||
        (response.username === "peer-005" && file.filename.includes("50. Daft Punk - Get Lucky (Radio Edit)")),
    );
    const original = run(originalVsRadio);
    expect(original.outcome).toBe("selected");
    if (original.outcome !== "selected") return;
    expect(original.versionClass).toBe("original");
    expect(original.file.size).toBeLessThanOrEqual(30 * MIB);

    const radioOnly = only((response, file) => response.username === "peer-005" && /radio edit/i.test(file.filename));
    const radio = run(radioOnly);
    expect(radio.outcome).toBe("selected");
    if (radio.outcome !== "selected") return;
    expect(radio.versionClass).toBe("radio_edit");
    expect(radio.file.size).toBeLessThanOrEqual(30 * MIB);
  });

  it("returns no pick when every candidate is rejected", () => {
    const decision = run(only((_response, file) => (file.size ?? 0) > 200 * MIB));
    expect(decision.outcome).toBe("no_suitable_result");
    if (decision.outcome !== "no_suitable_result") return;
    expect(decision.reason.startsWith("no_suitable_result:")).toBe(true);
    expect(decision.removed.max_file_size).toBeGreaterThan(0);
  });

  it("lets an explicit version override the saved preference", () => {
    const radio = run(curated, {
      versionPreference: "extended",
      query: { artist: "Daft Punk", title: "Get Lucky (Radio Edit)" },
    });
    expect(radio.outcome).toBe("selected");
    if (radio.outcome !== "selected") return;
    expect(radio.versionClass).toBe("radio_edit");
    expect(radio.breakdown.requestedVersion).toBe(1);
    expect(radio.file.size).toBeLessThanOrEqual(30 * MIB);

    const album = run(curated, {
      versionPreference: "remix",
      query: { artist: "Daft Punk", title: "Get Lucky (Album Version)" },
    });
    expect(album.outcome).toBe("selected");
    if (album.outcome !== "selected") return;
    expect(album.versionClass).toBe("original");
    expect(album.breakdown.requestedVersion).toBe(1);
    expect(album.file.filename.toLowerCase()).not.toContain("remix");
  });

  it("uses mp3_only and flac_only as filters", () => {
    const mp3 = run(curated, { formatPreference: "mp3_only" });
    const flac = run(curated, { formatPreference: "flac_only" });
    expect(mp3.outcome).toBe("selected");
    expect(flac.outcome).toBe("selected");
    if (mp3.outcome !== "selected" || flac.outcome !== "selected") return;
    expect(mp3.file.extension).toBe(".mp3");
    expect(flac.file.extension).toBe(".flac");
    expect(flac.file.size).toBeLessThanOrEqual(30 * MIB);
    expect(flac.versionClass).toBe("original");
  });

  it("rejects files over 30 MiB, including a 200 MiB file", () => {
    const overThirty = run(only((_response, file) => (file.size ?? 0) > 30 * MIB));
    const overTwoHundred = run(only((_response, file) => (file.size ?? 0) > 200 * MIB));
    expect(overThirty.outcome === "selected" || overThirty.outcome === "no_suitable_result").toBe(true);
    if (overThirty.outcome === "selected" || overThirty.outcome === "no_suitable_result") {
      expect(overThirty.removed.max_file_size).toBeGreaterThan(0);
    }
    expect(overTwoHundred.outcome).toBe("no_suitable_result");
    if (overTwoHundred.outcome === "no_suitable_result") expect(overTwoHundred.removed.max_file_size).toBeGreaterThan(0);
  });
});

describe("real artist and title rows", () => {
  function one(username: string, needle: string): SearchPayload {
    return only((response, file) => response.username === username && file.filename.includes(needle));
  }

  function rejectedAs(payload: SearchPayload, reason: "medley" | "tribute_or_cover" | "stem" | "short_recording" | "max_file_size") {
    const decision = run(payload);
    expect(decision.outcome).toBe("no_suitable_result");
    if (decision.outcome !== "no_suitable_result") return;
    expect(decision.removed[reason]).toBeGreaterThan(0);
  }

  function passesIdentity(payload: SearchPayload) {
    const decision = run(payload);
    const removed = reasonCounts(decision);
    expect(removed.title_mismatch ?? 0).toBe(0);
    expect(removed.medley ?? 0).toBe(0);
    expect(removed.tribute_or_cover ?? 0).toBe(0);
    expect(removed.artist_mismatch ?? 0).toBe(0);
    return decision;
  }

  it("rejects the tribute medley, the Daughter covers, a stem, and a short file", () => {
    rejectedAs(one("peer-192", "Nu Deco Ensemble"), "medley");
    rejectedAs(one("peer-013", "Daughter - Get Lucky"), "tribute_or_cover");
    rejectedAs(one("peer-097", "Daughter - Get Lucky"), "tribute_or_cover");
    rejectedAs(one("peer-018", "Daughter - Get Lucky"), "tribute_or_cover");
    rejectedAs(one("peer-010", "drums.ogg"), "stem");
    const shortFile = only(
      (response, file) => response.username === "peer-092" && file.filename.includes("dir21\\Daft Punk - Get Lucky Remix.mp3"),
    );
    const sibling = only((response, file) => response.username === "peer-001" && file.filename.includes("(Original Mix)"));
    const shortDecision = selectSearch(
      { responses: [...shortFile.responses, ...sibling.responses] },
      { allowedExtensions: AUDIO, query: SONG, shortRecordingMinSamples: 2 },
    );
    expect(shortDecision.outcome).toBe("selected");
    if (shortDecision.outcome === "selected") {
      expect(shortDecision.removed.short_recording).toBeGreaterThan(0);
      expect(shortDecision.file.filename.endsWith("Daft Punk - Get Lucky Remix.mp3")).toBe(false);
    }
  });

  it("passes the artist and title filter for the listed real names", () => {
    const paths = [
      ["peer-092", "Daft Punk_Get Lucky_02_Get Lucky (radio edit)"],
      ["peer-205", "Daft Punk_Get Lucky_02_Get Lucky (album version)"],
      ["peer-005", "26. Daft Punk - Get Lucky (Radio Edit - feat."],
      ["peer-096", "102_daft_punk_feat.pharrell_williams-get_lucky.mp3"],
      ["peer-069", "Get Lucky Feat. Pharrell Williams (Radio Edit) - Daft Punk.mp3"],
      ["peer-151", "mikeandtess - Daft Punk"],
      ["peer-155", "Get Lucky (Radio Edit) [feat."],
    ] as const;
    for (const [username, needle] of paths) {
      const decision = passesIdentity(one(username, needle));
      expect(decision.outcome === "selected" || decision.outcome === "no_suitable_result").toBe(true);
    }
    const albumFlac = run(one("peer-205", "album version"));
    expect(albumFlac.outcome).toBe("no_suitable_result");
    if (albumFlac.outcome === "no_suitable_result") expect(albumFlac.removed.max_file_size).toBe(1);

    const folderTitle = run(one("peer-105", "ゲット"));
    expect(folderTitle.outcome).toBe("no_suitable_result");
    if (folderTitle.outcome === "no_suitable_result") {
      expect(folderTitle.removed.title_mismatch).toBe(0);
      expect(folderTitle.removed.artist_mismatch).toBe(0);
      expect(folderTitle.removed.max_file_size).toBe(1);
    }
  });

  it("reports the mashup, the other-song remix, and the Pantelis file without a special rule", () => {
    for (const [username, needle] of [
      ["peer-056", "HALFSTEP Mashup"],
      ["peer-084", "Spooky Scary Skeletons"],
      ["peer-069", "Dj Pantelis"],
    ] as const) {
      const decision = run(one(username, needle));
      expect(["selected", "no_suitable_result"]).toContain(decision.outcome);
      if (decision.outcome === "selected") {
        expect(decision.versionClass).toEqual(expect.any(String));
      }
    }
  });
});

describe("dry-run grid", () => {
  it("is stable and covers the saved classes and the two explicit requests", () => {
    const first = JSON.stringify(dryRunPreferences(curated));
    const second = JSON.stringify(dryRunPreferences(curated));
    expect(second).toBe(first);
    const rows = dryRunPreferences(curated);
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.outcome === "selected" && (row.titleMatch ?? 0) > 0 && (row.artistInPath ?? 0) > 0)).toBe(
      true,
    );
    const explicit = dryRunExplicitRequests(curated);
    expect(explicit.map((row) => row.queryTitle)).toEqual(["Get Lucky (Radio Edit)", "Get Lucky (Album Version)"]);
    expect(explicit[0]?.versionClass).toBe("radio_edit");
    expect(explicit[1]?.versionClass).toBe("original");
  });
});
