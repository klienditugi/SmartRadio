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

    const albumNamed = mp3("album-named", "Daft Punk - Get Lucky (Album Version).mp3");
    const albumRequest = selected([remix, albumNamed], {
      versionPreference: "remix",
      query: { artist: "Daft Punk", title: "Get Lucky (Album Version)" },
    });
    expect(albumRequest.pick.peer).toBe("album-named");
    expect(albumRequest.versionClass).toBe("original");
    expect(albumRequest.breakdown.requestedVersion).toBe(1);

    const unmarked = selected([remix, album], {
      versionPreference: "remix",
      query: { artist: "Daft Punk", title: "Get Lucky (Album Version)" },
    });
    expect(unmarked.pick.peer).toBe("album");
    expect(unmarked.versionClass).toBe("original");
    expect(unmarked.breakdown.requestedVersion).toBe(0);
  });

  it("reads version class from the basename, not a folder", () => {
    const backup = mp3("backup", "Daft punk - Get Lucky (Feat. Pharrell Williams).mp3", {
      path: "@@share\\00_ORIGINAL_BACKUP\\Daft punk - Get Lucky (Feat. Pharrell Williams).mp3",
    });
    const mashupFolder = mp3("plain", "Daft Punk - Get Lucky.mp3", {
      path: "@@share\\2021 - About And Technologic Mashup (2021)\\Daft Punk - Get Lucky.mp3",
    });
    expect(fileVersionClass(backup)).toBe("original");
    expect(fileVersionClass(mashupFolder)).toBe("original");
    const asked = scoreTrack(backup, { query: { artist: "Daft Punk", title: "Get Lucky (Original Mix)" } });
    expect(asked.breakdown.requestedVersion).toBe(0);
    expect(asked.breakdown.titleMatch).toBe(1);
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

  it("requires the title phrase to start at a boundary in the original basename", () => {
    const leadingYou = mp3("you", "Tom Petty X Daft Punk - You Get Lucky (Adam Dutch Segue).mp3");
    const woman = mp3("woman", "Destiny's Child X Daft Punk - Independant Woman X Get Lucky.mp3");
    const gluedMashup = mp3("glued", "Daft Punk and Someone _Other Song and Get Lucky_ Remix Mashup.mp3");
    const djEdit = mp3("dj-edit", "DJ Example Get Lucky.mp3");
    const betweenArtist = mp3("between", "Daft Punk Feat. Someone Get Lucky.mp3");
    const mojibake = mp3("mojibake", "Daft Punk Feat. Pharrell & Nile Rodgers GÇô Get Lucky (eSQUIRE Extended).mp3");
    for (const wrong of [leadingYou, woman, gluedMashup, djEdit, betweenArtist, mojibake]) {
      const decision = selectTracks([wrong], { query });
      expect(decision.outcome).toBe("no_suitable_result");
      if (decision.outcome === "no_suitable_result") expect(decision.removed.title_mismatch).toBe(1);
    }

    const mind = mp3("mind", "Get Lucky Mind Control (HALFSTEP Mashup).mp3");
    const forTheMusic = mp3("music", "Daft Punk - Get Lucky For The Music.mp3");
    const skeletons = mp3("gold", "Andrew Gold - Spooky Scary Skeletons (Remixed with Daft Punk - Get Lucky).mp3");
    const luckyMusic = mp3("lucky-music", "Get Lucky Music.mp3");
    expect(scoreTrack(mind, { query }).breakdown.titleMatch).toBe(1);
    expect(fileVersionClass(mind)).toBe("remix");
    const mindOnly = selectTracks([mind], { query });
    expect(mindOnly.outcome).toBe("no_suitable_result");
    if (mindOnly.outcome === "no_suitable_result") expect(mindOnly.removed.medley).toBe(1);
    expect(scoreTrack(forTheMusic, { query }).breakdown.titleMatch).toBe(1);
    expect(fileVersionClass(forTheMusic)).toBe("original");
    expect(scoreTrack(skeletons, { query }).breakdown.titleMatch).toBe(1);
    expect(fileVersionClass(skeletons)).toBe("original");
    expect(scoreTrack(luckyMusic, { query }).breakdown.titleMatch).toBe(1);
    expect(fileVersionClass(luckyMusic)).toBe("original");

    const spacedArtist = mp3("spaced", "Daft Punk get lucky.mp3");
    const afterClose = mp3("close", "08 [Daft Punk, Pharrell Williams] Get Lucky.flac");
    const afterParen = mp3("paren", "Artist (feat. Name) Get Lucky.mp3");
    const tightBracket = mp3("tight", "08 [Daft Punk]Get Lucky.mp3");
    for (const file of [spacedArtist, afterClose, afterParen, tightBracket]) {
      expect(scoreTrack(file, { query }).breakdown.titleMatch).toBe(1);
    }
    expect(selected([spacedArtist]).pick.peer).toBe("spaced");

    const oneJoin = mp3("allan", "06. Dj Allan _ Daft Punk X Rob & Jack - Get Lucky (Dj Allan I Got U Bootleg).mp3");
    const pantelis = mp3("pantelis", "Get Lucky (Dj Pantelis Private Mix) - Dj Pantelis Does Daft Punk.mp3");
    const folderTitle = mp3("folder-title", "1 - remix.flac", {
      path: "@@share\\Daft Punk\\Get Lucky (Daft Punk remix)\\1 - remix.flac",
    });
    expect(fileVersionClass(oneJoin)).toBe("remix");
    expect(selected([oneJoin]).pick.peer).toBe("allan");
    expect(selected([pantelis]).pick.peer).toBe("pantelis");
    expect(selected([folderTitle]).pick.peer).toBe("folder-title");
    expect(scoreTrack(folderTitle, { query }).breakdown.titleMatch).toBe(1);

    const scene = [
      "08-daft_punk-get_lucky_(feat._pharrell_williams_and_nile_rodgers).flac",
      "Daft_Punk-Get_Lucky.mp3",
      "201-daft_punk_ft._pharrell_williams-get_lucky.flac",
      "102_daft_punk_feat.pharrell_williams-get_lucky.mp3",
      "06-daft_punk_(feat._pharrell_williams)-get_lucky_(116_bpm).mp3",
      "Get_Lucky_(feat._Pharrell_Williams_and_Nile_Rodgers).flac",
      "Daft Punk_Random Access Memories_08_Get Lucky.flac",
      "16. Get Lucky (Radio Edit) [Daft Punk ft. Pharrell Williams] iskal.mp3",
      "DAFT PUNK - GET LUCKY SFM REMIX.mp3",
      "Daft Punk - Get Lucky Remix Electro R5.mp3",
      "Daft Punk-Get Lucky (dj Ko Remix) www.my-free-mp3.net .mp3",
      "10A - 117 - Get Lucky.mp3",
      "1-08 Get Lucky.mp3",
      "1.08. Get Lucky.flac",
      "1 8 Get Lucky.flac",
      "Daft Punk_Random Access Memories_01-08_Get Lucky.flac",
    ];
    for (const name of scene) {
      const file = mp3(name, name);
      expect(scoreTrack(file, { query }).breakdown.titleMatch).toBe(1);
      if (name.toLowerCase().includes("daft")) {
        expect(scoreTrack(file, { query }).breakdown.artistInPath).toBe(1);
      }
    }
    const unclosed = mp3("unclosed", "Daft Punk (Feat. Name - Get Lucky (Remix).mp3");
    expect(scoreTrack(unclosed, { query }).breakdown.titleMatch).toBe(1);
    const underscoredArtist = mp3("artist", "daft_punk-get_lucky.mp3");
    expect(scoreTrack(underscoredArtist, { query }).breakdown.artistInPath).toBe(1);

    const singleOther = mp3("single", "Get Lucky _ Contact.mp3");
    expect(selected([singleOther]).pick.peer).toBe("single");
    const production = mp3("hd", "Get Lucky (club mix) (24bit88.2kHz) FOR HD PRODUCTION.wav", {
      path: "@@share\\Get Lucky (club mix) (24bit88.2kHz) FOR HD PRODUCTION.wav",
    });
    expect(scoreTrack(production, { query }).breakdown.titleMatch).toBe(1);
  });

  it("rejects a 105 second file when the cohort median says it is short", () => {
    const shorts = mp3("home", "Daft Punk - Get Lucky (HOME Remix).flac", {
      path: "@@share\\Daft Punk - Get Lucky (HOME Remix).flac",
      durationSeconds: 105,
      bitrateKbps: undefined,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    const longs = Array.from({ length: 6 }, (_, index) =>
      mp3(`long-${index}`, "Daft Punk - Get Lucky (Radio Edit).flac", {
        path: `@@share\\long-${index}\\Daft Punk - Get Lucky (Radio Edit).flac`,
        durationSeconds: 300,
        bitrateKbps: undefined,
        bitDepth: 16,
        sampleRateHz: 44100,
      }),
    );
    const alone = selectTracks([shorts], { query, formatPreference: "flac_only" });
    expect(alone.outcome).toBe("selected");
    const cohort = selectTracks([shorts, ...longs], { query, formatPreference: "flac_only" });
    expect(cohort.outcome).toBe("selected");
    if (cohort.outcome !== "selected") return;
    expect(cohort.removed.short_recording).toBe(1);
    expect(cohort.versionClass).toBe("radio_edit");
  });

  it("rejects a tribute or cover and a medley, and keeps a title-first file", () => {
    const cover = mp3("cover", "Daughter - Get Lucky (Daft Punk Cover).mp3");
    const medley = mp3("medley", "Daft Punk - Get Lucky _ Giorgio by Moroder _ Contact.flac");
    const nuDeco = mp3("nu-deco", "Nu Deco Ensemble - Giorgio by Moroder _ Get Lucky _ Contact.flac");
    const titleFirst = mp3("title-first", "Get Lucky Feat. Pharrell Williams (Radio Edit) - Daft Punk.mp3");
    const coverOnly = selectTracks([cover], { query });
    const medleyOnly = selectTracks([medley], { query });
    const nuDecoOnly = selectTracks([nuDeco], { query });
    expect(coverOnly.outcome).toBe("no_suitable_result");
    expect(medleyOnly.outcome).toBe("no_suitable_result");
    expect(nuDecoOnly.outcome).toBe("no_suitable_result");
    if (coverOnly.outcome === "no_suitable_result") expect(coverOnly.removed.tribute_or_cover).toBe(1);
    if (medleyOnly.outcome === "no_suitable_result") expect(medleyOnly.removed.medley).toBe(1);
    if (nuDecoOnly.outcome === "no_suitable_result") expect(nuDecoOnly.removed.title_mismatch).toBe(1);
    expect(selected([titleFirst, cover, medley]).pick.peer).toBe("title-first");

    const leadingCover = mp3("bachata", "Daft Punk - Get Lucky - ( LJ & Willy William Bachata Version ) Cover.mp3");
    const silver = mp3("silver", "Daft Punk - Get Lucky (Silver Nail Cover Mix).mp3");
    const barnett = mp3("barnett", "Daft Punk- Get Lucky  George Barnett cover.mp3");
    const kaevohia = mp3("kaevohia", "daft_punk-get_lucky_(kaevohia_cover's_remix_edit).m4a");
    const stepkids = mp3("stepkids", "Get Lucky - Daft Punk (The Stepkids' Cover).mp3");
    for (const file of [leadingCover, silver, barnett, kaevohia, stepkids]) {
      const decision = selectTracks([file], { query });
      expect(decision.outcome).toBe("no_suitable_result");
      if (decision.outcome === "no_suitable_result") expect(decision.removed.tribute_or_cover).toBe(1);
    }
    expect(fileVersionClass(leadingCover)).toBe("remix");

    const mashup = mp3("mashup", "Daft Punk - Get Lucky (Mashup).mp3");
    const mashUp = mp3("mash-up", "Daft Punk - Get Lucky (mash-up).mp3");
    const mashSpace = mp3("mash-space", "Get Lucky mash up.mp3");
    const segue = mp3("segue", "Daft Punk - Get Lucky (Segue).mp3");
    const transition = mp3("transition", "Daft Punk - Get Lucky (Wordplay Transition).mp3");
    for (const file of [mashup, mashUp, mashSpace, segue, transition]) {
      const decision = selectTracks([file], { query });
      expect(decision.outcome).toBe("no_suitable_result");
      if (decision.outcome === "no_suitable_result") expect(decision.removed.medley).toBe(1);
    }
    const inMashupFolder = mp3("folder-mashup", "Daft Punk - Get Lucky.mp3", {
      path: "music\\Mashup\\Daft Punk - Get Lucky.mp3",
    });
    const folderMashup = selectTracks([inMashupFolder], { query });
    expect(folderMashup.outcome).toBe("selected");
    if (folderMashup.outcome === "selected") expect(folderMashup.removed.medley).toBe(0);
    const beeGees = mp3("bee-gees", "Daft Punk VS Bee Gees - Get Lucky-You Should Be Dancing.mp3");
    const billieJean = mp3("billie", "Daft Punk VS Michael Jackson - Get Lucky-Billie Jean.mp3");
    const billieFirst = mp3("billie-first", "Daft Punk VS Michael Jackson - Billie Jean-Get Lucky.mp3");
    const versus = mp3("versus", "Daft Punk versus Someone - Get Lucky.mp3");
    const vsDot = mp3("vs-dot", "Daft Punk vs. Someone - Get Lucky.mp3");
    for (const file of [beeGees, billieJean, billieFirst, versus, vsDot]) {
      const decision = selectTracks([file], { query });
      expect(decision.outcome).toBe("no_suitable_result");
      if (decision.outcome === "no_suitable_result") expect(decision.removed.medley).toBe(1);
    }
    const inVsFolder = mp3("folder-vs", "Daft Punk - Get Lucky.mp3", {
      path: "music\\vs\\Daft Punk - Get Lucky.mp3",
    });
    const folderVs = selectTracks([inVsFolder], { query });
    expect(folderVs.outcome).toBe("selected");
    if (folderVs.outcome === "selected") expect(folderVs.removed.medley).toBe(0);
    const bootleg = mp3("bootleg", "06. Dj Allan _ Daft Punk X Rob & Jack - Get Lucky (Dj Allan I Got U Bootleg)[Clean].mp3");
    const editOnly = mp3("edit", "Daft Punk - Get Lucky (Radio Edit).mp3");
    const remixOnly = mp3("remix-word", "Daft Punk - Get Lucky (Remix).mp3");
    const xOnly = mp3("x", "Daft Punk X Pharrell - Get Lucky.mp3");
    const featOnly = mp3("feat", "Daft Punk feat. Pharrell Williams - Get Lucky.mp3");
    const ftOnly = mp3("ft", "Daft Punk ft. Pharrell Williams - Get Lucky.mp3");
    expect(selected([bootleg, editOnly, remixOnly, xOnly, featOnly, ftOnly]).pick.peer).toBe("bootleg");
    expect(selected([bootleg]).removed.medley).toBe(0);
    const inCoverFolder = mp3("album", "Daft Punk - Get Lucky.mp3", {
      path: "music\\cover\\Daft Punk - Get Lucky.mp3",
    });
    const image = mp3("image", "cover.jpg", { path: "music\\Daft Punk - Get Lucky\\cover.jpg" });
    const withImage = selectTracks([inCoverFolder, image], {
      query,
      allowedExtensions: [".mp3", ".flac", ".m4a", ".ogg", ".wav"],
    });
    expect(withImage.outcome).toBe("selected");
    if (withImage.outcome === "selected") {
      expect(withImage.pick.peer).toBe("album");
      expect(withImage.removed.tribute_or_cover).toBe(0);
      expect(withImage.removed.extensions).toBe(1);
    }
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
