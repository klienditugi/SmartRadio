/**
 * Selector preferences against the sanitized Phase C slskd search.
 * Curated rows are chosen by tag and passed through the slskd adapter.
 * SYNTHETIC-long-recordings.json is the only stand-in, for phrases the real search does not contain.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SCORE_WEIGHTS } from "@subwave-ai/core";
import { describe, expect, it } from "vitest";
import { selectSearch, type SearchSelection, type SelectSearchOptions } from "./select.js";
import { dryRunPreferences } from "./selector-dryrun.js";

const FIXTURES = new URL("../../../core/test/fixtures/slskd-phase-c/", import.meta.url);

type SlskdFile = { filename: string } & Record<string, unknown>;
type SlskdResponse = { username: string; files?: SlskdFile[]; lockedFiles?: unknown[] } & Record<string, unknown>;
type SearchPayload = { responses: SlskdResponse[] } & Record<string, unknown>;
type TagRow = { username: string; filename: string; tags: string[] };

const curatedUrl = new URL("phase-c-curated.json", FIXTURES);
const tagsUrl = new URL("phase-c-curated-tags.json", FIXTURES);
const curated = JSON.parse(readFileSync(curatedUrl, "utf8")) as SearchPayload & {
  responseCount?: number;
  fileCount?: number;
  lockedFileCount?: number;
};
const tagRows = JSON.parse(readFileSync(tagsUrl, "utf8")) as TagRow[];
const synthetic = JSON.parse(
  readFileSync(new URL("./fixtures/SYNTHETIC-long-recordings.json", import.meta.url), "utf8"),
) as SearchPayload & { label: string };

const AUDIO = [".mp3", ".flac", ".m4a", ".ogg", ".wav"] as const;
const SONG = { artist: "Daft Punk", title: "Get Lucky" };
const VERSIONS = ["balanced", "radio_edit", "original", "extended", "remix"] as const;
const FORMATS = ["auto", "prefer_mp3", "prefer_flac", "mp3_only", "flac_only"] as const;

const tagKey = (username: string, filename: string) => `${username}\0${filename}`;
const tagsByFile = new Map(tagRows.map((row) => [tagKey(row.username, row.filename), row.tags]));

function tagged(match: (tags: string[], row: TagRow) => boolean): SearchPayload {
  const wanted = new Set(tagRows.filter((row) => match(row.tags, row)).map((row) => tagKey(row.username, row.filename)));
  const responses: SlskdResponse[] = [];
  for (const response of curated.responses) {
    const files = (response.files ?? []).filter((file) => wanted.has(tagKey(response.username, file.filename)));
    if (files.length === 0) continue;
    responses.push({ ...response, files, lockedFiles: [] });
  }
  return { responses };
}

function hasTag(tag: string, extra?: (tags: string[], row: TagRow) => boolean): SearchPayload {
  return tagged((tags, row) => tags.includes(tag) && (extra?.(tags, row) ?? true));
}

function withSynthetic(payload: SearchPayload, usernames: readonly string[]): SearchPayload {
  const extra = synthetic.responses.filter((response) => usernames.includes(response.username));
  return { responses: [...payload.responses, ...extra] };
}

function run(payload: unknown, opts: SelectSearchOptions = {}): SearchSelection {
  return selectSearch(payload, { allowedExtensions: AUDIO, query: SONG, ...opts });
}

function pick(payload: unknown, opts: SelectSearchOptions = {}): Extract<SearchSelection, { outcome: "selected" }> {
  const decision = run(payload, opts);
  expect(decision.outcome).toBe("selected");
  if (decision.outcome !== "selected") throw new Error("expected a pick");
  expect(decision.total).toBe(Object.values(decision.breakdown).reduce((sum, value) => sum + value, 0));
  expect(decision.removed.locked).toEqual(expect.any(Number));
  return decision;
}

function tagsOf(file: { username: string; filename: string }): string[] {
  return tagsByFile.get(tagKey(file.username, file.filename)) ?? [];
}

function blobSha(url: URL): string {
  const bytes = readFileSync(url);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

describe("sanitized Phase C fixtures", () => {
  it("keeps the cleaned curated extract in slskd response shape", () => {
    expect(curated.responses).toHaveLength(28);
    expect(tagRows).toHaveLength(73);
    const tagNames = new Set(tagRows.flatMap((row) => row.tags));
    for (const tag of [
        "mp3_320_album",
        "mp3_256",
        "mp3_192",
        "mp3_128",
        "mp3_low_lt128",
        "mp3_vbr",
        "bitrate_junk",
        "flac_16_44",
        "flac_24_hires",
        "extended",
        "club_mix",
        "radio_edit",
        "original_mix",
        "remix_named",
        "remix_daft_punk",
        "mix_word_other",
        "mixshow",
        "stem_ogg",
        "ogg_remix",
        "opus",
        "m4a",
        "wav",
        "cd1_folder_normal_track",
        "peer_no_free_slot",
        "peer_long_queue",
        "junk_appledouble",
        "tiny_audio",
        "non_audio",
      ]) {
        expect(tagNames.has(tag)).toBe(true);
      }
    expect(curated.responseCount).toBe(251);
    expect(curated.fileCount).toBe(583);
    expect(curated.lockedFileCount).toBe(33);
    expect(curated.responses.every((response) => (response.lockedFiles ?? []).length === 0)).toBe(true);
    expect(synthetic.label).toBe("SYNTHETIC");
    expect(blobSha(curatedUrl)).toBe("fe3ed1a7173ed07b30a1c29610193371ba6e9056");
    expect(blobSha(tagsUrl)).toBe("9e0bca0069bae44d25b90e0266114c7d26970bd5");
  });

  it("is deterministic for inline, wrapped, and bare-array copies of the real rows", () => {
    const payload = hasTag("radio_edit");
    const opts = { allowedExtensions: AUDIO, query: SONG, versionPreference: "radio_edit" as const };
    const inline = selectSearch(payload, opts);
    const wrapped = selectSearch({ responses: payload.responses }, opts);
    const bare = selectSearch(payload.responses, opts);
    expect(inline).toEqual(wrapped);
    expect(bare).toEqual(inline);
    expect(inline.outcome).toBe("selected");
  });
});

describe("real Phase C version rows", () => {
  const cast = tagged((tags) =>
    ["radio_edit", "original_mix", "extended", "remix_named", "remix_daft_punk", "ogg_remix", "mix_word_other", "mp3_320_album"].some(
      (tag) => tags.includes(tag),
    ),
  );

  it("gives balanced no version bonus and still selects a file", () => {
    const decision = pick(cast, { versionPreference: "balanced" });
    expect(decision.breakdown.versionPreference).toBe(0);
    expect(decision.breakdown.requestedVersion).toBe(0);
  });

  it("ranks radio edit, original, extended, and remix, and falls back when the preferred version is missing", () => {
    const radio = pick(cast, { versionPreference: "radio_edit" });
    expect(tagsOf(radio.file)).toContain("radio_edit");
    expect(radio.breakdown.versionPreference).toBe(240);
    expect(radio.file.username).toBe("peer-005");

    const original = pick(cast, { versionPreference: "original" });
    expect(tagsOf(original.file)).toContain("original_mix");
    expect(original.breakdown.versionPreference).toBe(240);
    const explicitOriginal = pick(hasTag("original_mix", (tags) => tags.includes("mix_word_other")), { versionPreference: "original" });
    expect(explicitOriginal.file.filename).toContain("Original Mix");
    expect(explicitOriginal.breakdown.versionPreference).toBe(240);
    const clean = pick(hasTag("mp3_320_album", (tags) => tags.length === 1), { versionPreference: "original" });
    expect(clean.breakdown.versionPreference).toBe(160);

    const extended = pick(cast, { versionPreference: "extended" });
    expect(tagsOf(extended.file)).toContain("extended");
    expect(extended.breakdown.versionPreference).toBe(240);
    expect(extended.breakdown.longRecording).toBe(0);

    const remix = pick(cast, { versionPreference: "remix" });
    expect(remix.breakdown.versionPreference).toBe(240);
    expect(remix.file.filename.toLowerCase()).toContain("remix");
    expect(tagsOf(remix.file)).not.toContain("mixshow");

    const bare = pick(hasTag("mix_word_other", (tags) => !tags.includes("original_mix")), { versionPreference: "remix" });
    expect(bare.breakdown.versionPreference).toBe(0);
    expect(tagsOf(bare.file)).toContain("mix_word_other");
    const bareAgainstRemix = pick(
      tagged((tags) => (tags.includes("mix_word_other") && !tags.includes("original_mix")) || tags.includes("remix_named")),
      { versionPreference: "remix" },
    );
    expect(tagsOf(bareAgainstRemix.file)).toContain("remix_named");

    const fallback = pick(
      tagged((tags) => ["original_mix", "extended", "remix_named", "mp3_320_album"].some((tag) => tags.includes(tag))),
      { versionPreference: "radio_edit" },
    );
    expect(fallback.outcome).toBe("selected");
    expect(tagsOf(fallback.file)).not.toContain("radio_edit");
    expect(fallback.breakdown.versionPreference).toBe(0);
  });

  it("lets an explicit request override every saved preference", () => {
    const people = tagged((tags, row) => {
      if (tags.includes("radio_edit") && row.username === "peer-005") return row.filename.includes("(Radio Edit).mp3");
      if (tags.includes("original_mix") && tags.includes("mix_word_other")) return true;
      if (tags.includes("extended") && !tags.includes("mp3_no_length") && row.filename.includes("Extended Studio Version")) return true;
      if (tags.includes("remix_named") && row.filename.includes("FAT TONY")) return true;
      if (tags.includes("mp3_320_album") && row.username === "peer-004") return true;
      return false;
    });
    for (const versionPreference of VERSIONS) {
      const text = versionPreference === "extended" ? "radio edit" : "extended mix";
      const decision = pick(people, { versionPreference, query: { ...SONG, text } });
      expect(decision.breakdown.requestedVersion).toBe(1000);
      expect(decision.file.filename.toLowerCase()).toContain(text === "radio edit" ? "radio edit" : "extended");
    }
  });

  it("treats club mix as a normal extended track once the hard caps let it through", () => {
    const clubs = hasTag("club_mix");
    const blocked = run(clubs);
    expect(blocked).toMatchObject({ outcome: "no_suitable_result", removed: { max_file_size: 3, max_sample_rate: 0 } });
    const opened = pick(clubs, { versionPreference: "extended", maxSampleRate: 192_000, maxFileSizeMb: null });
    expect(tagsOf(opened.file)).toContain("club_mix");
    expect(opened.breakdown.versionPreference).toBe(240);
    expect(opened.breakdown.longRecording).toBe(0);
  });

  it("does not treat a bare mix or a Mixshow as the saved remix", () => {
    const mixshow = pick(hasTag("mixshow"), { versionPreference: "remix" });
    expect(mixshow.file.filename.toLowerCase()).toContain("mixshow");
    expect(mixshow.breakdown.versionPreference).toBe(0);
    expect(mixshow.breakdown.longRecording).toBe(-280);
    const against = pick(
      tagged((tags) => tags.includes("mixshow") || (tags.includes("mp3_320_album") && tags.length === 1)),
      { versionPreference: "remix" },
    );
    expect(tagsOf(against.file)).toContain("mp3_320_album");
    expect(against.breakdown.longRecording).toBe(0);
  });

  it("keeps stems and an acapella last", () => {
    const decision = pick(
      tagged(
        (tags, row) =>
          tags.includes("stem_ogg") ||
          (tags.includes("mp3_128") && row.filename.includes("Acapella")) ||
          (tags.includes("mp3_320_album") && tags.length === 1),
      ),
      { versionPreference: "remix" },
    );
    expect(tagsOf(decision.file)).toContain("mp3_320_album");
    expect(pick(hasTag("stem_ogg"), { versionPreference: "remix" }).breakdown.stem).toBe(-1600);
    const acapella = pick(tagged((tags, row) => tags.includes("mp3_128") && row.filename.includes("Acapella")));
    expect(acapella.breakdown.stem).toBe(-1600);
  });

  it("treats a CD1 folder as a normal track", () => {
    const cd = pick(hasTag("cd1_folder_normal_track", (tags) => tags.includes("cd1_folder_normal_track") && !tags.includes("flac_24_hires")));
    expect(cd.file.filename).toContain("CD1");
    expect(cd.breakdown.longRecording).toBe(0);
    expect(cd.removed.max_sample_rate).toBe(0);
  });
});

describe("real Phase C format, quality, and peers", () => {
  const pair = tagged((tags, row) => {
    if (row.username === "peer-005" && row.filename.endsWith("014.  Daft Punk - Get Lucky.mp3")) return true;
    if (row.username === "peer-003" && tags.includes("flac_16_44")) return true;
    return false;
  });

  it("applies auto, prefer_mp3, prefer_flac, and the hard _only filters", () => {
    expect(tagsOf(pick(pair, { formatPreference: "prefer_mp3" }).file)).toContain("mp3_320_album");
    expect(tagsOf(pick(pair, { formatPreference: "prefer_flac" }).file)).toContain("flac_16_44");
    expect(tagsOf(pick(pair, { formatPreference: "auto" }).file)).toContain("mp3_320_album");

    const mp3 = pick(hasTag("mp3_320_album", (_tags, row) => row.username === "peer-005" && row.filename.includes("014.")), {
      formatPreference: "auto",
    });
    const flac = pick(hasTag("flac_16_44", (_tags, row) => row.username === "peer-003"), { formatPreference: "auto" });
    expect(mp3.breakdown.quality).toBe(flac.breakdown.quality);
    expect(mp3.breakdown.format).toBe(0);
    expect(flac.breakdown.format).toBe(0);
    expect(flac.breakdown.sizeOvershoot).toBeGreaterThan(-10);
    expect(flac.breakdown.sizeOvershoot).toBeLessThan(0);

    expect(tagsOf(pick(hasTag("flac_16_44"), { formatPreference: "prefer_mp3" }).file)).toContain("flac_16_44");
    expect(tagsOf(pick(hasTag("mp3_320_album"), { formatPreference: "prefer_flac" }).file)).toContain("mp3_320_album");

    const onlyFlac = run(hasTag("flac_16_44"), { formatPreference: "mp3_only" });
    expect(onlyFlac).toMatchObject({ outcome: "no_suitable_result", removed: { format_preference: 4, extensions: 0 } });
    const onlyMp3 = run(hasTag("mp3_320_album"), { formatPreference: "flac_only" });
    expect(onlyMp3).toMatchObject({ outcome: "no_suitable_result", removed: { format_preference: 5 } });
  });

  it("does not let a 128 kbps mp3 beat a 320 or a 16/44.1 FLAC under prefer_mp3", () => {
    const low = tagged((tags, row) => tags.includes("mp3_128") && row.filename.includes("Official Audio"));
    const better = tagged((tags, row) => {
      if (tags.includes("mp3_128") && row.filename.includes("Official Audio")) return true;
      if (row.username === "peer-005" && row.filename.includes("014.")) return true;
      if (row.username === "peer-003" && tags.includes("flac_16_44")) return true;
      return false;
    });
    expect(pick(low, { formatPreference: "prefer_mp3" }).breakdown.quality).toBeLessThan(0);
    expect(tagsOf(pick(better, { formatPreference: "prefer_mp3" }).file)).not.toContain("mp3_128");
    const versusFlac = tagged((tags, row) => {
      if (tags.includes("mp3_128") && row.filename.includes("Official Audio")) return true;
      if (row.username === "peer-003" && tags.includes("flac_16_44")) return true;
      return false;
    });
    expect(tagsOf(pick(versusFlac, { formatPreference: "prefer_mp3" }).file)).toContain("flac_16_44");
  });

  it("scores 256 and 320 in the same good tier and 192 as acceptable", () => {
    const q320 = pick(hasTag("mp3_320_album", (_tags, row) => row.username === "peer-005" && row.filename.includes("014.")));
    const q256 = pick(hasTag("mp3_256"));
    const q192 = pick(hasTag("mp3_192", (_tags, row) => row.username === "peer-015"));
    expect(q256.breakdown.quality).toBe(q320.breakdown.quality);
    expect(q192.breakdown.quality).toBe(SCORE_WEIGHTS.qualityAcceptable);
    expect(q192.breakdown.quality).toBeLessThan(q320.breakdown.quality);
  });

  it("treats junk bitrates as unknown", () => {
    const open = { minFileSizeMb: null, maxFileSizeMb: null };
    const junk = tagRows.filter((row) => row.tags.includes("bitrate_junk"));
    expect(junk.map((row) => row.filename).join("\n")).toMatch(/song\.ogg/);
    expect(junk.map((row) => row.filename).join("\n")).toMatch(/2991|Daft Punk remix/);
    for (const row of junk) {
      const decision = pick(tagged((_tags, candidate) => candidate.filename === row.filename && candidate.username === row.username), open);
      expect(decision.signals).toEqual({ quality: "unknown" });
      expect(decision.breakdown.quality).toBe(0);
    }
    const visible = pick(hasTag("bitrate_junk", (tags) => !tags.includes("stem_ogg")), { maxFileSizeMb: null });
    expect(visible.breakdown.quality).toBe(0);
    const againstAlbum = pick(
      tagged((tags) => tags.includes("bitrate_junk") || (tags.includes("mp3_320_album") && tags.length === 1)),
      { maxFileSizeMb: null },
    );
    expect(tagsOf(againstAlbum.file)).toEqual(expect.arrayContaining(["mp3_320_album"]));
  });

  it("gives in-cap hi-res FLAC no extra credit and excludes 88.2 kHz by default", () => {
    const blocked = run(hasTag("flac_24_hires", (tags) => !tags.includes("club_mix")));
    expect(blocked).toMatchObject({ outcome: "no_suitable_result", removed: { max_sample_rate: 3 } });
    const cd = pick(hasTag("flac_16_44", (_tags, row) => row.username === "peer-003"));
    const hires = pick(hasTag("flac_24_hires", (tags) => !tags.includes("club_mix")), { maxSampleRate: 192_000 });
    expect(hires.breakdown.quality).toBe(cd.breakdown.quality);
    expect(hires.file.filename.endsWith(".flac")).toBe(true);
  });

  it("does not use 30 MiB as a cutoff", () => {
    const flac = pick(hasTag("flac_16_44", (_tags, row) => row.username === "peer-003"), { formatPreference: "prefer_mp3" });
    expect(flac.breakdown.sizeOvershoot).toBeLessThan(0);
    expect(flac.file.size).toBeGreaterThan(30 * 1024 * 1024);
    const poor = tagged((tags, row) => {
      if (row.username === "peer-003" && tags.includes("flac_16_44")) return true;
      if (tags.includes("mp3_128") && row.filename.includes("Official Audio")) return true;
      return false;
    });
    expect(tagsOf(pick(poor, { formatPreference: "prefer_mp3" }).file)).toContain("flac_16_44");
  });

  it("keeps opus and other extension rows eligible when the allowlist includes them", () => {
    const opus = pick(hasTag("opus"), { allowedExtensions: [...AUDIO, ".opus"] });
    expect(tagsOf(opus.file)).toContain("opus");
    expect(opus.signals).toEqual({ quality: "unknown" });
    const noLength = pick(hasTag("extended", (tags) => tags.includes("mp3_no_length")), { versionPreference: "extended" });
    expect(noLength.breakdown.versionPreference).toBe(240);
    expect(noLength.signals.quality).toBe("unknown");
    expect(tagsOf(pick(hasTag("m4a", (_tags, row) => row.filename.includes("08 08"))).file)).toContain("m4a");
    expect(run(hasTag("wav"))).toMatchObject({
      outcome: "no_suitable_result",
      removed: { max_file_size: 1, max_sample_rate: 1 },
    });
    const vbr = pick(hasTag("mp3_vbr"));
    expect(vbr.signals.quality).toBe("reported");
    expect(vbr.breakdown.quality).toBeLessThan(SCORE_WEIGHTS.qualityAcceptable);
  });

  it("scores a 239 kbps VBR MP3 as good; the 73 curated files have none", () => {
    const curatedVbrHigh: { username: string; filename: string; bitRate: number }[] = [];
    let curatedFiles = 0;
    for (const response of curated.responses) {
      for (const file of response.files ?? []) {
        curatedFiles += 1;
        const bitRate = file.bitRate;
        if (file.isVariableBitRate !== true || typeof bitRate !== "number") continue;
        if (bitRate === 239 || bitRate === 240) {
          curatedVbrHigh.push({ username: response.username, filename: file.filename, bitRate });
        }
      }
    }
    expect(curatedFiles).toBe(73);
    // None of the 73 curated files is a 239 or 240 kbps VBR row. The VBR MP3s
    // in this extract are 189 kbps, so the good-tier case below is SYNTHETIC.
    expect(curatedVbrHigh).toEqual([]);

    const syntheticVbr = {
      label: "SYNTHETIC",
      responses: [
        {
          username: "SYNTHETIC-vbr-v0",
          hasFreeUploadSlot: true,
          queueLength: 0,
          uploadSpeed: 1_000_000,
          files: [
            {
              filename: "@@share\\SYNTHETIC\\Daft Punk - Get Lucky.mp3",
              size: 8 * 1024 * 1024,
              length: 360,
              extension: "mp3",
              bitRate: 239,
              isVariableBitRate: true,
            },
          ],
        },
      ],
    };
    const vbr = pick(syntheticVbr);
    expect(vbr.pick.vbr).toBe(true);
    expect(vbr.pick.bitrateKbps).toBe(239);
    expect(vbr.breakdown.quality).toBe(SCORE_WEIGHTS.qualityGood);

    const syntheticCbr = {
      label: "SYNTHETIC",
      responses: [
        {
          username: "SYNTHETIC-cbr-239",
          hasFreeUploadSlot: true,
          queueLength: 0,
          uploadSpeed: 1_000_000,
          files: [
            {
              filename: "@@share\\SYNTHETIC\\Daft Punk - Get Lucky.mp3",
              size: 8 * 1024 * 1024,
              length: 360,
              extension: "mp3",
              bitRate: 239,
            },
          ],
        },
      ],
    };
    const cbr = pick(syntheticCbr);
    expect(cbr.pick.vbr).toBeUndefined();
    expect(cbr.breakdown.quality).toBe(SCORE_WEIGHTS.qualityAcceptable);
  });

  it("prefers a free slot over a long queue on otherwise similar radio edits", () => {
    const radios = hasTag("radio_edit");
    const decision = pick(radios, { versionPreference: "radio_edit" });
    expect(decision.file.username).toBe("peer-005");
    const busy = pick(hasTag("radio_edit", (_tags, row) => row.username === "peer-001"), { versionPreference: "radio_edit" });
    const free = pick(hasTag("radio_edit", (_tags, row) => row.username === "peer-005"), { versionPreference: "radio_edit" });
    expect(free.breakdown.availability).toBeGreaterThan(busy.breakdown.availability);
    expect(free.breakdown.versionPreference).toBe(busy.breakdown.versionPreference);

    const queued = pick(hasTag("peer_long_queue"));
    expect(queued.breakdown.availability).toBeLessThanOrEqual(-60);
    const against = pick(tagged((tags) => tags.includes("peer_long_queue") || (tags.includes("mp3_320_album") && tags.length === 1)));
    expect(tagsOf(against.file)).toContain("mp3_320_album");
  });

  it("drops AppleDouble junk, tiny audio, and non-audio", () => {
    expect(run(hasTag("junk_appledouble"))).toMatchObject({ outcome: "no_suitable_result", removed: { junk: 2 } });
    const tiny = tagged((_tags, row) => row.tags.includes("tiny_audio") && row.filename.endsWith(".mp3") && !row.filename.includes("._"));
    expect(run(tiny)).toMatchObject({ outcome: "no_suitable_result", removed: { min_file_size: 1 } });
    expect(run(hasTag("non_audio"))).toMatchObject({ outcome: "no_suitable_result", removed: { extensions: 3 } });
  });
});

describe("SYNTHETIC long recordings", () => {
  it("keeps DJ sets, continuous mixes, radio shows, podcasts, full albums, and concerts out of the version bonus", () => {
    const album = hasTag("mp3_320_album", (tags) => tags.length === 1);
    const dj = pick(withSynthetic(album, ["SYNTHETIC-dj-set"]), { versionPreference: "remix" });
    expect(dj.file.username).not.toContain("SYNTHETIC");
    const djOnly = pick(withSynthetic({ responses: [] }, ["SYNTHETIC-dj-set"]), { versionPreference: "remix" });
    expect(djOnly.file.username).toContain("SYNTHETIC");
    expect(djOnly.breakdown.versionPreference).toBe(0);
    expect(djOnly.breakdown.longRecording).toBe(-280);

    expect(pick(withSynthetic(album, ["SYNTHETIC-continuous-60"]), { versionPreference: "remix" }).file.username).not.toContain("SYNTHETIC");
    expect(run(withSynthetic({ responses: [] }, ["SYNTHETIC-continuous-60"]), { versionPreference: "remix" })).toMatchObject({
      outcome: "no_suitable_result",
      removed: { max_duration: 1 },
    });

    expect(pick(withSynthetic(album, ["SYNTHETIC-continuous-15"]), { versionPreference: "extended" }).file.username).not.toContain("SYNTHETIC");
    const quarter = pick(withSynthetic({ responses: [] }, ["SYNTHETIC-continuous-15"]), { versionPreference: "extended" });
    expect(quarter.breakdown.versionPreference).toBe(0);
    expect(quarter.breakdown.longRecording).toBe(-280);
    expect(quarter.breakdown.durationOvershoot).toBeLessThan(0);

    expect(pick(withSynthetic(hasTag("radio_edit"), ["SYNTHETIC-radio-show"]), { versionPreference: "radio_edit" }).file.username).toBe("peer-005");
    expect(pick(withSynthetic({ responses: [] }, ["SYNTHETIC-radio-show"]), { versionPreference: "radio_edit" }).breakdown.longRecording).toBe(-280);
    expect(pick(withSynthetic(album, ["SYNTHETIC-podcast"]), { versionPreference: "remix" }).file.username).not.toContain("SYNTHETIC");
    expect(pick(withSynthetic({ responses: [] }, ["SYNTHETIC-podcast"])).breakdown.longRecording).toBe(-280);
    expect(pick(withSynthetic(album, ["SYNTHETIC-full-album"]), { versionPreference: "extended" }).file.username).not.toContain("SYNTHETIC");
    expect(pick(withSynthetic({ responses: [] }, ["SYNTHETIC-full-album"])).breakdown.longRecording).toBe(-280);
    expect(pick(withSynthetic(album, ["SYNTHETIC-concert"]), { versionPreference: "remix" }).file.username).not.toContain("SYNTHETIC");
    expect(pick(withSynthetic({ responses: [] }, ["SYNTHETIC-concert"])).breakdown.longRecording).toBe(-280);
  });

  it("counts a SYNTHETIC lockedFiles row and does not select it", () => {
    const album = hasTag("mp3_320_album", (tags) => tags.length === 1);
    const beside = pick(withSynthetic(album, ["SYNTHETIC-locked"]));
    expect(beside.file.username).not.toContain("SYNTHETIC");
    expect(beside.removed.locked).toBe(1);
    const only = run(withSynthetic({ responses: [] }, ["SYNTHETIC-locked"]));
    expect(only).toMatchObject({ outcome: "no_suitable_result", removed: { locked: 1 } });
  });
});

describe("priority on real rows", () => {
  it("lets the higher priority win when the other real file is better lower down", () => {
    const weakRemix = tagged((tags) => tags.includes("ogg_remix"));
    const strongClean = hasTag("mp3_320_album", (_tags, row) => row.username === "peer-005" && row.filename.includes("014."));
    const remixSet = { responses: [...strongClean.responses, ...weakRemix.responses] };
    expect(pick(remixSet, { versionPreference: "remix", formatPreference: "prefer_mp3" }).file.filename.toLowerCase()).toContain("remix");

    const show = hasTag("mixshow", (tags) => tags.length === 1 || tags.includes("mixshow"));
    const normal = hasTag("mp3_320_album", (tags) => tags.length === 1);
    expect(tagsOf(pick({ responses: [...show.responses, ...normal.responses] }, { versionPreference: "remix" }).file)).toContain("mp3_320_album");

    const low = tagged((tags, row) => tags.includes("mp3_128") && row.filename.includes("Official Audio"));
    const flac = hasTag("flac_16_44", (_tags, row) => row.username === "peer-003");
    expect(tagsOf(pick({ responses: [...low.responses, ...flac.responses] }, { formatPreference: "prefer_mp3" }).file)).toContain("flac_16_44");
    expect(tagsOf(pick({ responses: [...low.responses, ...flac.responses] }, { formatPreference: "mp3_only" }).file)).toContain("mp3_128");
    expect(run(flac, { formatPreference: "mp3_only" })).toMatchObject({ outcome: "no_suitable_result", removed: { format_preference: 1 } });

    const mp3 = hasTag("mp3_320_album", (_tags, row) => row.username === "peer-005" && row.filename.includes("014."));
    expect(tagsOf(pick({ responses: [...mp3.responses, ...flac.responses] }, { formatPreference: "prefer_flac" }).file)).toContain("flac_16_44");

    const huge = hasTag("club_mix", (tags) => tags.includes("club_mix") && !tags.includes("wav"));
    const smallBusy = hasTag("peer_no_free_slot", (_tags, row) => row.filename.includes("(10s)"));
    const sized = pick(
      { responses: [...huge.responses, ...smallBusy.responses] },
      { formatPreference: "auto", versionPreference: "balanced", maxSampleRate: 192_000, maxFileSizeMb: null },
    );
    expect(tagsOf(sized.file)).toContain("peer_no_free_slot");

    expect(pick(hasTag("radio_edit"), { versionPreference: "balanced" }).file.username).toBe("peer-005");
    const samePeer = pick(hasTag("radio_edit", (_tags, row) => row.username === "peer-005"), { versionPreference: "radio_edit" });
    expect(samePeer.file.filename).toContain("26. Daft Punk");
  });
});

const fullFixture = process.env.SMARTRADIO_PHASE_C_FULL_FIXTURE;

describe.skipIf(!fullFixture)("optional full Phase C search", () => {
  it("prints a stable pick per preference and counts 33 locked files", () => {
    const payload = JSON.parse(readFileSync(fullFixture!, "utf8"));
    const first = dryRunPreferences(payload);
    const second = dryRunPreferences(payload);
    expect(second).toEqual(first);
    expect(first.length).toBe(VERSIONS.length * FORMATS.length);
    for (const row of first) {
      expect(row.outcome).toBe("selected");
      expect(row.locked).toBe(33);
      console.log(
        `${row.versionPreference} + ${row.formatPreference}\t${row.username}\t${row.filename}\tsize=${row.size}\ttotal=${row.total}\tlocked=${row.locked}\t${JSON.stringify(row.breakdown)}`,
      );
    }
  });
});
