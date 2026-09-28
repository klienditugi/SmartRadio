import { describe, expect, it } from "vitest";
import { fileVersionClass, scoreTrack, selectTracks, type CandidateTrack } from "./index.js";

const MIB = 1024 * 1024;
const query = { artist: "Daft Punk", title: "Get Lucky" };

function track(partial: Partial<CandidateTrack> & Pick<CandidateTrack, "peer" | "path" | "sizeBytes">): CandidateTrack {
  const parts = partial.path.split(/[/\\]/).filter((part) => part.length > 0);
  const basename = partial.basename ?? parts[parts.length - 1] ?? partial.path;
  const folders = partial.folders ?? parts.slice(0, -1);
  const ext = partial.format?.ext ?? (basename.includes(".") ? `.${basename.split(".").pop()!.toLowerCase()}` : "");
  const lossless = partial.format?.lossless ?? (ext === ".flac" || ext === ".wav");
  return {
    peer: partial.peer,
    path: partial.path,
    basename,
    folders,
    sizeBytes: partial.sizeBytes,
    ...(partial.durationSeconds !== undefined ? { durationSeconds: partial.durationSeconds } : {}),
    format: { ext, lossless },
    ...(partial.bitrateKbps !== undefined ? { bitrateKbps: partial.bitrateKbps } : {}),
    ...(partial.sampleRateHz !== undefined ? { sampleRateHz: partial.sampleRateHz } : {}),
    ...(partial.bitDepth !== undefined ? { bitDepth: partial.bitDepth } : {}),
    ...(partial.vbr !== undefined ? { vbr: partial.vbr } : {}),
    ...(partial.availability ? { availability: partial.availability } : {}),
    locked: partial.locked ?? false,
  };
}

function mp3(peer: string, name: string, extra: Partial<CandidateTrack> = {}): CandidateTrack {
  return track({
    peer,
    path: `@@share\\${peer}\\${name}`,
    sizeBytes: 12 * MIB,
    durationSeconds: 280,
    bitrateKbps: 320,
    availability: { freeSlot: true, queueLength: 0, speedBps: 1_000_000 },
    ...extra,
  });
}

function selected(tracks: CandidateTrack[], opts: Parameters<typeof selectTracks>[1] = {}) {
  const decision = selectTracks(tracks, { query, ...opts });
  expect(decision.outcome).toBe("selected");
  if (decision.outcome !== "selected") throw new Error("expected a pick");
  return decision;
}

describe("ordered selector", () => {
  const remix = mp3("remix", "Daft Punk - Get Lucky (FAT TONY Remix).mp3");
  const club = mp3("club", "Daft Punk - Get Lucky (Club Mix).mp3");
  const extended = mp3("extended", "Daft Punk - Get Lucky (Extended Mix).mp3");
  const album = mp3("album", "Daft Punk - Get Lucky.mp3");
  const radio = mp3("radio", "Daft Punk - Get Lucky (Radio Edit).mp3", { bitrateKbps: 192 });

  it("picks a remix, club, or extended file of 30 MiB or less when one is available", () => {
    for (const fun of [remix, club, extended]) {
      const decision = selected([fun, album, radio]);
      expect(decision.pick.peer).toBe(fun.peer);
      expect(["remix", "extended"]).toContain(decision.versionClass);
      expect(decision.pick.sizeBytes).toBeLessThanOrEqual(30 * MIB);
      expect(decision.breakdown.titleMatch).toBe(1);
      expect(decision.breakdown.artistInPath).toBe(1);
    }
    const together = selected([remix, club, extended, album]);
    expect(["remix", "club", "extended"]).toContain(together.pick.peer);
  });

  it("picks the album or original when no remix, club, or extended file remains", () => {
    const decision = selected([album, radio]);
    expect(decision.pick.peer).toBe("album");
    expect(decision.versionClass).toBe("original");
  });

  it("falls back to the best acceptable radio edit, and returns no pick when nothing survives", () => {
    const poorRadio = mp3("poor-radio", "Daft Punk - Get Lucky (Radio Edit).mp3", { bitrateKbps: 128 });
    const decision = selected([radio, poorRadio]);
    expect(decision.pick.peer).toBe("radio");
    expect(decision.versionClass).toBe("radio_edit");
    expect(decision.breakdown.quality).toBe(1);

    const none = selectTracks([], { query });
    expect(none.outcome).toBe("no_suitable_result");
    const blocked = selectTracks([track({ peer: "txt", path: "notes.txt", sizeBytes: 12 * MIB })], {
      query,
      allowedExtensions: [".mp3", ".flac"],
    });
    expect(blocked.outcome).toBe("no_suitable_result");
    if (blocked.outcome === "no_suitable_result") expect(blocked.reason).toContain("no_suitable_result");
  });

  it("lets an explicit version override the saved preference", () => {
    const radioRequest = selected([remix, extended, radio], {
      versionPreference: "extended",
      query: { artist: "Daft Punk", title: "Get Lucky (Radio Edit)" },
    });
    expect(radioRequest.pick.peer).toBe("radio");
    expect(radioRequest.breakdown.requestedVersion).toBe(1);
    expect(radioRequest.breakdown.versionPreference).toBe(0);

    const albumRequest = selected([remix, album], {
      versionPreference: "remix",
      query: { artist: "Daft Punk", title: "Get Lucky (Album Version)" },
    });
    expect(albumRequest.pick.peer).toBe("album");
    expect(albumRequest.versionClass).toBe("original");
    expect(albumRequest.breakdown.requestedVersion).toBe(1);
  });

  it("treats mp3_only and flac_only as filters", () => {
    const flac = track({
      peer: "flac",
      path: "@@share\\Album\\Get Lucky.flac",
      sizeBytes: 28 * MIB,
      durationSeconds: 280,
      bitDepth: 16,
      sampleRateHz: 44100,
      availability: { freeSlot: true, queueLength: 0, speedBps: 2_000_000 },
    });
    expect(selected([remix, flac], { formatPreference: "mp3_only" }).pick.peer).toBe("remix");
    expect(selected([remix, flac], { formatPreference: "flac_only" }).pick.peer).toBe("flac");
    expect(selected([remix, flac], { formatPreference: "prefer_flac", versionPreference: "original" }).pick.peer).toBe("flac");
  });

  it("rejects a file over 30 MiB and a 200 MiB file", () => {
    const big = mp3("big", "Daft Punk - Get Lucky (Extended Mix).mp3", { sizeBytes: 31 * MIB });
    const huge = mp3("huge", "Daft Punk - Get Lucky (Extended Mix).mp3", { sizeBytes: 220 * MIB });
    const over = selectTracks([big], { query });
    const enormous = selectTracks([huge], { query });
    expect(over.outcome).toBe("no_suitable_result");
    expect(enormous.outcome).toBe("no_suitable_result");
    if (over.outcome === "no_suitable_result") expect(over.removed.max_file_size).toBe(1);
    if (enormous.outcome === "no_suitable_result") expect(enormous.removed.max_file_size).toBe(1);
    expect(selected([big, remix]).pick.peer).toBe("remix");
  });

  it("rejects a filename that does not contain the title", () => {
    const missing = mp3("other", "Daft Punk - One More Time.mp3");
    const decision = selectTracks([missing, remix], { query });
    expect(decision.outcome).toBe("selected");
    if (decision.outcome !== "selected") return;
    expect(decision.pick.peer).toBe("remix");
    expect(decision.removed.title_mismatch).toBe(1);
    expect(scoreTrack(missing, { query }).breakdown.titleMatch).toBe(0);
    expect(scoreTrack(remix, { query }).breakdown.titleMatch).toBeGreaterThan(0);
    expect(scoreTrack(remix, { query }).breakdown.artistInPath).toBeGreaterThan(0);
  });

  it("keeps the hybrid title rule", () => {
    const hybrid = mp3("hybrid", "Daft Punk - Get Lucky (original vocal club remix edit).mp3");
    const radioRemix = mp3("radio-remix", "Daft Punk - Get Lucky (Radio Edit - WBBL Remix).mp3");
    expect(fileVersionClass(hybrid)).toBe("remix");
    expect(fileVersionClass(radioRemix)).toBe("remix");
    expect(fileVersionClass(club)).toBe("extended");
    expect(fileVersionClass(album)).toBe("original");
    const asked = selected([hybrid, album], {
      query: { artist: "Daft Punk", title: "Get Lucky (Album Version)" },
      versionPreference: "remix",
    });
    expect(asked.pick.peer).toBe("album");
  });

  it("rejects stems, short files, long recordings, locked files, and bitrate under 128", () => {
    const stem = mp3("stem", "drums.ogg", { path: "@@share\\Daft Punk\\Get Lucky\\drums.ogg" });
    const short = mp3("short", "Daft Punk - Get Lucky.mp3", { durationSeconds: 40 });
    const djSet = mp3("set", "Daft Punk - Get Lucky.mp3", { path: "@@share\\DJ Set\\Daft Punk - Get Lucky.mp3" });
    const locked = mp3("locked", "Daft Punk - Get Lucky.mp3", { locked: true });
    const low = mp3("low", "Daft Punk - Get Lucky.mp3", { bitrateKbps: 96 });
    const decision = selectTracks([stem, short, djSet, locked, low], { query });
    expect(decision.outcome).toBe("no_suitable_result");
    if (decision.outcome !== "no_suitable_result") return;
    expect(decision.removed.stem).toBe(1);
    expect(decision.removed.short_recording).toBe(1);
    expect(decision.removed.long_recording).toBe(1);
    expect(decision.removed.locked).toBe(1);
    expect(decision.removed.under_bitrate).toBe(1);
  });

  it("rejects a tribute or cover and a medley, and keeps a title-first file", () => {
    const cover = mp3("cover", "Daughter - Get Lucky (Daft Punk Cover).mp3");
    const medley = mp3("medley", "Nu Deco Ensemble - Giorgio by Moroder _ Get Lucky _ Contact.flac");
    const titleFirst = mp3("title-first", "Get Lucky Feat. Pharrell Williams (Radio Edit) - Daft Punk.mp3");
    const coverOnly = selectTracks([cover], { query });
    const medleyOnly = selectTracks([medley], { query });
    expect(coverOnly.outcome).toBe("no_suitable_result");
    expect(medleyOnly.outcome).toBe("no_suitable_result");
    if (coverOnly.outcome === "no_suitable_result") expect(coverOnly.removed.tribute_or_cover).toBe(1);
    if (medleyOnly.outcome === "no_suitable_result") expect(medleyOnly.removed.medley).toBe(1);
    expect(selected([titleFirst, cover, medley]).pick.peer).toBe("title-first");
  });

  it("ranks acceptable above poor, then format, then peer, then username", () => {
    const poor = mp3("aaa-poor", "Daft Punk - Get Lucky (Remix).mp3", { bitrateKbps: 160 });
    const good = mp3("zzz-good", "Daft Punk - Get Lucky (Remix).mp3", { bitrateKbps: 192 });
    expect(selected([poor, good]).pick.peer).toBe("zzz-good");

    const vbr = mp3("vbr", "Daft Punk - Get Lucky (Remix).mp3", { bitrateKbps: 180, vbr: true });
    expect(selected([poor, vbr]).pick.peer).toBe("vbr");
    expect(scoreTrack(vbr, { query }).breakdown.quality).toBe(1);

    const flac = track({
      peer: "flac",
      path: "@@share\\Album\\Get Lucky (Remix).flac",
      sizeBytes: 20 * MIB,
      durationSeconds: 280,
      bitDepth: 16,
      sampleRateHz: 44100,
      availability: { freeSlot: false, queueLength: 40, speedBps: 1 },
    });
    expect(selected([good, flac], { formatPreference: "prefer_flac" }).pick.peer).toBe("flac");

    const busy = mp3("busy", "Daft Punk - Get Lucky (Remix).mp3", {
      availability: { freeSlot: false, queueLength: 0, speedBps: 9_000_000 },
    });
    const free = mp3("free", "Daft Punk - Get Lucky (Remix).mp3", {
      availability: { freeSlot: true, queueLength: 3, speedBps: 1 },
    });
    expect(selected([busy, free]).pick.peer).toBe("free");

    const slow = mp3("slow", "a\\Daft Punk - Get Lucky (Remix).mp3", {
      availability: { freeSlot: true, queueLength: 1, speedBps: 100 },
    });
    const fast = mp3("fast", "z\\Daft Punk - Get Lucky (Remix).mp3", {
      availability: { freeSlot: true, queueLength: 1, speedBps: 5_000_000 },
    });
    expect(selected([slow, fast]).pick.peer).toBe("fast");
  });

  it("treats an MP3 with no bitrate as poor unless size and length derive an acceptable rate", () => {
    const unknown = mp3("unknown", "Daft Punk - Get Lucky (Remix).mp3", {
      bitrateKbps: undefined,
      durationSeconds: undefined,
    });
    expect(scoreTrack(unknown, { query }).signals.quality).toBe("unknown");
    expect(scoreTrack(unknown, { query }).breakdown.quality).toBe(0);
    const derived = mp3("derived", "Daft Punk - Get Lucky (Remix).mp3", {
      bitrateKbps: undefined,
      sizeBytes: 10 * MIB,
      durationSeconds: 369,
    });
    expect(scoreTrack(derived, { query }).signals.quality).toBe("derived");
    expect(scoreTrack(derived, { query }).breakdown.quality).toBe(1);
    expect(selected([unknown, derived]).pick.peer).toBe("derived");
  });

  it("moves a saved version class to the front and leaves the rest in the default order", () => {
    expect(selected([remix, extended, album], { versionPreference: "extended" }).pick.peer).toBe("extended");
    expect(selected([remix, extended, album], { versionPreference: "remix" }).pick.peer).toBe("remix");
    expect(selected([remix, album, radio], { versionPreference: "original" }).pick.peer).toBe("album");
    expect(selected([remix, album, radio], { versionPreference: "radio_edit" }).pick.peer).toBe("radio");
  });
});
