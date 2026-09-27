/**
 * Selector preferences against a real-shaped slskd fixture.
 * The JSON is raw search shape. Every pick goes through the slskd adapter.
 * SYNTHETIC rows are hour-scale or show-length stand-ins, named in the username and path.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectSearch, type SearchSelection, type SelectSearchOptions } from "./select.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/get-lucky-real-shaped.json", import.meta.url), "utf8")) as {
  label: string;
  responses: Array<{ username: string } & Record<string, unknown>>;
};

const AUDIO = [".mp3", ".flac", ".m4a", ".ogg", ".wav", ".opus"] as const;
const SONG = { artist: "Daft Punk", title: "Get Lucky" };
const VERSION_PREFERENCES = ["balanced", "radio_edit", "original", "extended", "remix"] as const;

function subset(usernames: readonly string[]) {
  const wanted = new Set(usernames);
  return { ...fixture, responses: fixture.responses.filter((row) => wanted.has(row.username)) };
}

function chosen(usernames: readonly string[], opts: SelectSearchOptions = {}): Extract<SearchSelection, { outcome: "selected" }> {
  const decision = selectSearch(subset(usernames), {
    allowedExtensions: AUDIO,
    query: SONG,
    ...opts,
  });
  expect(decision.outcome).toBe("selected");
  if (decision.outcome !== "selected") throw new Error("expected a pick");
  expect(decision.total).toBe(Object.values(decision.breakdown).reduce((sum, value) => sum + value, 0));
  expect(decision.breakdown.versionPreference).toEqual(expect.any(Number));
  expect(decision.breakdown.format).toEqual(expect.any(Number));
  expect(decision.breakdown.quality).toEqual(expect.any(Number));
  expect(decision.signals.quality).toMatch(/reported|derived|unknown/);
  return decision;
}

function response(username: string, file: Record<string, unknown>, peer: Record<string, unknown> = {}) {
  return {
    username,
    hasFreeUploadSlot: true,
    queueLength: 0,
    uploadSpeed: 1_600_000,
    ...peer,
    files: [file],
  };
}

describe("real-shaped version preference", () => {
  it("loads the real-shaped slskd fixture", () => {
    expect(fixture.label).toBe("real-shaped");
    expect(fixture.responses.length).toBeGreaterThan(10);
  });

  const cast = [
    "peer-a-clean",
    "peer-z-radio",
    "peer-z-single",
    "peer-z-original",
    "peer-z-album-version",
    "peer-z-extended",
    "peer-z-club",
    "peer-z-twelve",
    "peer-z-remix",
    "peer-z-rmx",
    "peer-z-named-edit",
    "peer-z-bare-mix",
    "peer-z-parent-extended",
  ];

  it("is deterministic across inline, wrapped, and bare-array inputs", () => {
    const payload = subset(cast);
    const inline = selectSearch(payload, { allowedExtensions: AUDIO, query: SONG, versionPreference: "balanced" });
    const wrapped = selectSearch({ responses: payload.responses }, { allowedExtensions: AUDIO, query: SONG, versionPreference: "balanced" });
    const bare = selectSearch(payload.responses, { allowedExtensions: AUDIO, query: SONG, versionPreference: "balanced" });
    expect(inline).toEqual(wrapped);
    expect(bare).toEqual(inline);
    expect(inline.outcome).toBe("selected");
  });

  it("balanced gives no version bonus and keeps the earliest equal file", () => {
    const decision = chosen(cast, { versionPreference: "balanced" });
    expect(decision.file.username).toBe("peer-a-clean");
    expect(decision.breakdown.versionPreference).toBe(0);
    expect(decision.breakdown.requestedVersion).toBe(0);
  });

  it("ranks each saved version, and falls back when that version is missing", () => {
    expect(chosen(["peer-a-clean", "peer-z-radio", "peer-z-extended", "peer-z-remix"], { versionPreference: "radio_edit" }).file.username).toBe(
      "peer-z-radio",
    );
    expect(chosen(["peer-z-radio", "peer-z-single"], { versionPreference: "radio_edit" }).breakdown.versionPreference).toBe(240);

    expect(chosen(["peer-a-clean", "peer-z-original", "peer-z-remix", "peer-z-bare-mix"], { versionPreference: "original" }).file.username).toBe(
      "peer-z-original",
    );
    const clean = chosen(["peer-a-clean"], { versionPreference: "original" });
    expect(clean.breakdown.versionPreference).toBe(160);
    expect(chosen(["peer-z-original"], { versionPreference: "original" }).breakdown.versionPreference).toBe(240);

    expect(chosen(["peer-a-clean", "peer-z-radio", "peer-z-extended", "peer-z-remix"], { versionPreference: "extended" }).file.username).toBe(
      "peer-z-extended",
    );
    expect(chosen(["peer-z-club"], { versionPreference: "extended" }).breakdown.versionPreference).toBe(240);
    expect(chosen(["peer-z-twelve"], { versionPreference: "extended" }).breakdown.versionPreference).toBe(240);
    expect(chosen(["peer-z-extended"], { versionPreference: "extended" }).breakdown.longRecording).toBe(0);

    expect(chosen(["peer-a-clean", "peer-z-extended", "peer-z-remix", "peer-z-bare-mix"], { versionPreference: "remix" }).file.username).toBe(
      "peer-z-remix",
    );
    expect(chosen(["peer-z-rmx"], { versionPreference: "remix" }).breakdown.versionPreference).toBe(240);
    expect(chosen(["peer-z-named-edit"], { versionPreference: "remix" }).breakdown.versionPreference).toBe(240);
    expect(chosen(["peer-z-bare-mix"], { versionPreference: "remix" }).breakdown.versionPreference).toBe(0);
    expect(chosen(["peer-z-club"], { versionPreference: "remix" }).breakdown.versionPreference).toBe(0);

    const fallback = chosen(
      ["peer-a-clean", "peer-z-original", "peer-z-extended", "peer-z-remix"],
      { versionPreference: "radio_edit" },
    );
    expect(fallback.file.username).toBe("peer-a-clean");
    expect(fallback.outcome).toBe("selected");
    expect(fallback.breakdown.versionPreference).toBe(0);
  });

  it("lets an explicit request override every saved preference", () => {
    const people = ["peer-a-clean", "peer-z-radio", "peer-z-original", "peer-z-extended", "peer-z-remix"];
    for (const versionPreference of VERSION_PREFERENCES) {
      const text = versionPreference === "extended" ? "radio edit" : "extended mix";
      const winner = text === "radio edit" ? "peer-z-radio" : "peer-z-extended";
      const decision = chosen(people, { versionPreference, query: { ...SONG, text } });
      expect(decision.file.username).toBe(winner);
      expect(decision.breakdown.requestedVersion).toBe(1000);
    }
  });

  it("treats a parent-folder version as a weaker signal than the basename", () => {
    const decision = chosen(["peer-a-clean", "peer-z-parent-extended", "peer-z-extended"], { versionPreference: "extended" });
    expect(decision.file.username).toBe("peer-z-extended");
    expect(decision.breakdown.versionPreference).toBe(240);
    expect(chosen(["peer-z-parent-extended"], { versionPreference: "extended" }).breakdown.versionPreference).toBe(80);
    expect(chosen(["peer-a-clean"], { versionPreference: "extended" }).breakdown.versionPreference).toBe(0);
  });

  it("keeps stems last under every preference", () => {
    for (const versionPreference of VERSION_PREFERENCES) {
      expect(chosen(["peer-a-clean", "peer-z-stem", "peer-z-acapella"], { versionPreference }).file.username).toBe("peer-a-clean");
      expect(chosen(["peer-z-stem"], { versionPreference }).breakdown.stem).toBe(-1600);
      expect(chosen(["peer-z-acapella"], { versionPreference }).breakdown.stem).toBe(-1600);
    }
  });
});

describe("real-shaped format, quality, and long recordings", () => {
  it("applies auto, prefer_mp3, prefer_flac, and the hard _only filters", () => {
    const pair = ["peer-fmt-mp3-320", "peer-fmt-flac-cd"];
    expect(chosen(pair, { formatPreference: "prefer_mp3" }).file.username).toBe("peer-fmt-mp3-320");
    expect(chosen(pair, { formatPreference: "prefer_flac" }).file.username).toBe("peer-fmt-flac-cd");
    const autoMp3 = chosen(["peer-fmt-mp3-320"], { formatPreference: "auto" });
    const autoFlac = chosen(["peer-fmt-flac-cd"], { formatPreference: "auto" });
    expect(chosen(pair, { formatPreference: "auto" }).file.username).toBe("peer-fmt-mp3-320");
    expect(autoMp3.breakdown.format).toBe(0);
    expect(autoFlac.breakdown.format).toBe(0);
    expect(autoMp3.breakdown.quality).toBe(autoFlac.breakdown.quality);
    expect(autoFlac.breakdown.sizeOvershoot).toBe(-5);
    expect(autoMp3.total - autoFlac.total).toBe(5);

    expect(chosen(["peer-fmt-flac-cd"], { formatPreference: "prefer_mp3" }).file.username).toBe("peer-fmt-flac-cd");
    expect(chosen(["peer-fmt-mp3-320"], { formatPreference: "prefer_flac" }).file.username).toBe("peer-fmt-mp3-320");

    const onlyFlac = selectSearch(subset(["peer-fmt-flac-cd", "peer-fmt-flac-34"]), {
      allowedExtensions: AUDIO,
      query: SONG,
      formatPreference: "mp3_only",
    });
    expect(onlyFlac).toMatchObject({
      outcome: "no_suitable_result",
      removed: { format_preference: 2, extensions: 0 },
    });
    if (onlyFlac.outcome === "no_suitable_result") expect(onlyFlac.reason).toContain("format_preference=2");

    const onlyMp3 = selectSearch(subset(["peer-fmt-mp3-320", "peer-fmt-mp3-128"]), {
      allowedExtensions: AUDIO,
      query: SONG,
      formatPreference: "flac_only",
    });
    expect(onlyMp3).toMatchObject({ outcome: "no_suitable_result", removed: { format_preference: 2 } });
  });

  it("does not let a 128 kbps mp3 beat a better file under prefer_mp3", () => {
    expect(chosen(["peer-fmt-mp3-128", "peer-fmt-flac-cd"], { formatPreference: "prefer_mp3" }).file.username).toBe("peer-fmt-flac-cd");
    expect(chosen(["peer-fmt-mp3-128", "peer-fmt-mp3-320"], { formatPreference: "prefer_mp3" }).file.username).toBe("peer-fmt-mp3-320");
    expect(chosen(["peer-fmt-mp3-128"], { formatPreference: "prefer_mp3" }).breakdown.quality).toBeLessThan(0);
  });

  it("treats junk bitrates as unknown and gives hi-res no extra credit", () => {
    for (const username of ["peer-fmt-junk-8", "peer-fmt-junk-2991", "peer-fmt-junk-400"]) {
      const junk = chosen([username]);
      expect(junk.signals).toEqual({ quality: "unknown" });
      expect(junk.breakdown.quality).toBe(0);
    }
    expect(chosen(["peer-fmt-junk-8", "peer-fmt-junk-400", "peer-fmt-mp3-320"]).file.username).toBe("peer-fmt-mp3-320");

    const cd = chosen(["peer-fmt-a-cd"]);
    const hires = chosen(["peer-fmt-z-hires"]);
    expect(hires.breakdown.quality).toBe(cd.breakdown.quality);
    expect(chosen(["peer-fmt-a-cd", "peer-fmt-z-hires"]).file.username).toBe("peer-fmt-a-cd");

    const excluded = selectSearch(subset(["peer-fmt-2496"]), { allowedExtensions: AUDIO, query: SONG });
    expect(excluded).toMatchObject({ outcome: "no_suitable_result", removed: { max_sample_rate: 1 } });
    const raisedHi = chosen(["peer-fmt-2496"], { maxSampleRate: 192_000 });
    expect(raisedHi.breakdown.quality).toBe(cd.breakdown.quality);
    expect(raisedHi.total).toBe(cd.total);
    expect(chosen(["peer-fmt-a-cd", "peer-fmt-2496"], { maxSampleRate: 192_000 }).file.username).toBe("peer-fmt-2496");
  });

  it("treats 30 MiB as a soft penalty, not a cutoff", () => {
    expect(chosen(["peer-fmt-good-35", "peer-fmt-poor-8"], { formatPreference: "prefer_mp3" }).file.username).toBe("peer-fmt-good-35");
    const flac = chosen(["peer-fmt-flac-34"]);
    expect(flac.file.username).toBe("peer-fmt-flac-34");
    expect(flac.breakdown.sizeOvershoot).toBeGreaterThan(-10);
    expect(flac.breakdown.sizeOvershoot).toBeLessThan(0);
  });

  it("keeps DJ sets, continuous mixes, and radio shows out of the version bonus", () => {
    expect(chosen(["peer-a-clean", "SYNTHETIC-dj-set"], { versionPreference: "remix" }).file.username).toBe("peer-a-clean");
    const dj = chosen(["SYNTHETIC-dj-set"], { versionPreference: "remix" });
    expect(dj.breakdown.versionPreference).toBe(0);
    expect(dj.breakdown.longRecording).toBe(-280);

    expect(chosen(["peer-a-clean", "SYNTHETIC-continuous-60"], { versionPreference: "remix" }).file.username).toBe("peer-a-clean");
    const hour = selectSearch(subset(["SYNTHETIC-continuous-60"]), { allowedExtensions: AUDIO, query: SONG, versionPreference: "remix" });
    expect(hour).toMatchObject({ outcome: "no_suitable_result", removed: { max_duration: 1 } });

    expect(chosen(["peer-a-clean", "SYNTHETIC-continuous-15"], { versionPreference: "extended" }).file.username).toBe("peer-a-clean");
    const quarter = chosen(["SYNTHETIC-continuous-15"], { versionPreference: "extended" });
    expect(quarter.breakdown.versionPreference).toBe(0);
    expect(quarter.breakdown.longRecording).toBe(-280);
    expect(quarter.breakdown.durationOvershoot).toBeLessThan(0);

    expect(chosen(["peer-a-clean", "SYNTHETIC-radio-show"], { versionPreference: "radio_edit" }).file.username).toBe("peer-a-clean");
    expect(chosen(["SYNTHETIC-radio-show"], { versionPreference: "radio_edit" }).breakdown.longRecording).toBe(-280);
    expect(chosen(["peer-a-clean", "SYNTHETIC-podcast"], { versionPreference: "remix" }).file.username).toBe("peer-a-clean");
    expect(chosen(["SYNTHETIC-podcast"]).breakdown.longRecording).toBe(-280);
  });
});

describe("priority order", () => {
  const base = { allowedExtensions: AUDIO, query: SONG };

  function pickPair(responses: unknown[], opts: SelectSearchOptions = {}) {
    const decision = selectSearch({ responses }, { ...base, ...opts });
    expect(decision.outcome).toBe("selected");
    if (decision.outcome !== "selected") throw new Error("expected a pick");
    return decision;
  }

  it("lets level N win when the other file is better on every lower level", () => {
    const rightSong = response("right-song", {
      filename: "@@abcde\\Daft Punk\\Album\\Get Lucky.mp3",
      size: 8 * 1024 * 1024,
      length: 369,
      extension: "",
      bitRate: 128,
    }, { hasFreeUploadSlot: false, queueLength: 40, uploadSpeed: 1 });
    const wrongSong = response("wrong-song", {
      filename: "@@abcde\\Other\\Other Song (Extended Mix).mp3",
      size: 10 * 1024 * 1024,
      length: 369,
      extension: "",
      bitRate: 320,
    });
    expect(
      pickPair([wrongSong, rightSong], { query: { ...SONG, text: "extended mix" }, versionPreference: "extended" }).file.username,
    ).toBe("right-song");

    const requested = response("requested-extended", {
      filename: "@@abcde\\Daft Punk\\Get Lucky (Extended Mix).mp3",
      size: 28 * 1024 * 1024,
      length: 510,
      extension: "",
      bitRate: 128,
    }, { hasFreeUploadSlot: false, queueLength: 80, uploadSpeed: 1 });
    const savedRadio = response("saved-radio", {
      filename: "@@abcde\\Daft Punk\\Get Lucky (Radio Edit).mp3",
      size: 8 * 1024 * 1024,
      length: 369,
      extension: "",
      bitRate: 320,
    }, { uploadSpeed: 20_000_000 });
    expect(
      pickPair([savedRadio, requested], { versionPreference: "radio_edit", query: { ...SONG, text: "extended mix" } }).file.username,
    ).toBe("requested-extended");

    const poorMp3 = response("poor-mp3", {
      filename: "@@abcde\\Daft Punk\\Album\\Get Lucky.mp3",
      size: 6 * 1024 * 1024,
      length: 369,
      extension: "",
      bitRate: 128,
    });
    const richFlac = response("rich-flac", {
      filename: "@@abcde\\Daft Punk\\Album\\Get Lucky.flac",
      size: 42 * 1024 * 1024,
      length: 369,
      extension: "",
      bitDepth: 16,
      sampleRate: 44100,
    });
    expect(pickPair([richFlac, poorMp3], { formatPreference: "mp3_only" }).file.username).toBe("poor-mp3");
    const blocked = selectSearch({ responses: [richFlac] }, { ...base, formatPreference: "mp3_only" });
    expect(blocked).toMatchObject({ outcome: "no_suitable_result", removed: { format_preference: 1 } });

    const weakRemix = response("weak-remix", {
      filename: "@@abcde\\Daft Punk\\Get Lucky (Purple Remix).mp3",
      size: 28 * 1024 * 1024,
      length: 400,
      extension: "",
      bitRate: 128,
    }, { hasFreeUploadSlot: false, queueLength: 50, uploadSpeed: 1 });
    const strongClean = response("strong-clean", {
      filename: "@@abcde\\Daft Punk\\Album\\06 Get Lucky.mp3",
      size: 10 * 1024 * 1024,
      length: 369,
      extension: "",
      bitRate: 320,
    }, { uploadSpeed: 20_000_000 });
    expect(pickPair([strongClean, weakRemix], { versionPreference: "remix", formatPreference: "auto" }).file.username).toBe("weak-remix");

    const normal = response("normal-cut", {
      filename: "@@abcde\\Daft Punk\\Album\\06 Get Lucky.mp3",
      size: 10 * 1024 * 1024,
      length: 369,
      extension: "",
      bitRate: 192,
    }, { hasFreeUploadSlot: false, queueLength: 10, uploadSpeed: 1 });
    const djSet = response("synth-dj", {
      filename: "@@abcde\\SYNTHETIC DJ Set\\Get Lucky (Remix DJ Set).mp3",
      size: 12 * 1024 * 1024,
      length: 600,
      extension: "",
      bitRate: 320,
    }, { uploadSpeed: 20_000_000 });
    expect(pickPair([djSet, normal], { versionPreference: "remix" }).file.username).toBe("normal-cut");

    expect(pickPair([richFlac, poorMp3], { formatPreference: "prefer_mp3" }).file.username).toBe("rich-flac");

    const smallMp3 = response("small-mp3", {
      filename: "@@abcde\\Daft Punk\\Album\\Get Lucky.mp3",
      size: 14 * 1024 * 1024,
      length: 369,
      extension: "",
      bitRate: 320,
    }, { hasFreeUploadSlot: false, queueLength: 8, uploadSpeed: 100 });
    const bigFlac = response("big-flac", {
      filename: "@@abcde\\Daft Punk\\FLAC 16-44.1\\Get Lucky.flac",
      size: 42 * 1024 * 1024,
      length: 369,
      extension: "",
      bitDepth: 16,
      sampleRate: 44100,
    }, { uploadSpeed: 20_000_000 });
    expect(pickPair([smallMp3, bigFlac], { formatPreference: "prefer_flac" }).file.username).toBe("big-flac");

    const tiny = response("tiny-good", {
      filename: "@@abcde\\Daft Punk\\Album\\Get Lucky.mp3",
      size: 10 * 1024 * 1024,
      length: 369,
      extension: "",
      bitRate: 320,
    }, { hasFreeUploadSlot: false, queueLength: 40, uploadSpeed: 1 });
    const huge = response("huge-good", {
      filename: "@@abcde\\Daft Punk\\Album\\Get Lucky.flac",
      size: 120 * 1024 * 1024,
      length: 369,
      extension: "",
      bitDepth: 16,
      sampleRate: 44100,
    }, { uploadSpeed: 50_000_000 });
    expect(pickPair([huge, tiny], { formatPreference: "auto" }).file.username).toBe("tiny-good");

    const busy = response("peer-busy", {
      filename: "@@abcde\\Daft Punk\\Album\\Get Lucky.mp3",
      size: 10 * 1024 * 1024,
      length: 369,
      extension: "",
      bitRate: 320,
    }, { hasFreeUploadSlot: false, queueLength: 8, uploadSpeed: 1 });
    const free = response("peer-free", {
      filename: "@@abcde\\Daft Punk\\Album\\Get Lucky.mp3",
      size: 10 * 1024 * 1024,
      length: 369,
      extension: "",
      bitRate: 320,
    });
    expect(pickPair([busy, free], { formatPreference: "auto" }).file.username).toBe("peer-free");

    const later = response("peer-b", {
      filename: "@@abcde\\Daft Punk\\Album\\B Get Lucky.mp3",
      size: 10 * 1024 * 1024,
      length: 369,
      extension: "",
      bitRate: 320,
    });
    const earlier = response("peer-a", {
      filename: "@@abcde\\Daft Punk\\Album\\B Get Lucky.mp3",
      size: 10 * 1024 * 1024,
      length: 369,
      extension: "",
      bitRate: 320,
    });
    const earlierPath = response("peer-a", {
      filename: "@@abcde\\Daft Punk\\Album\\A Get Lucky.mp3",
      size: 10 * 1024 * 1024,
      length: 369,
      extension: "",
      bitRate: 320,
    });
    expect(pickPair([later, earlier], { formatPreference: "auto" }).file.username).toBe("peer-a");
    expect(pickPair([earlier, earlierPath], { formatPreference: "auto" }).file.filename).toContain("A Get Lucky");
    expect(pickPair([later, earlier], { formatPreference: "auto" })).toEqual(pickPair([earlier, later], { formatPreference: "auto" }));
  });
});
