import {
  DEFAULT_BITRATE_FLOOR_KBPS,
  DEFAULT_MAX_FILE_SIZE_MB,
  DEFAULT_PREFERRED_MAX_FILE_SIZE_MB,
} from "@subwave-ai/shared";
import { describe, expect, it } from "vitest";
import { SCORE_WEIGHTS, scoreTrack, selectTracks, type CandidateTrack } from "./index.js";
import { classifyVersionText, normalizeMatchText } from "./selection-score.js";

const MIB = 1024 * 1024;

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

const query = { artist: "Daft Punk", title: "Get Lucky" };

function selected(tracks: CandidateTrack[], opts: Parameters<typeof selectTracks>[1] = {}) {
  const decision = selectTracks(tracks, opts);
  expect(decision.outcome).toBe("selected");
  if (decision.outcome !== "selected") throw new Error("expected a pick");
  expect(decision.total).toBe(Object.values(decision.breakdown).reduce((sum, value) => sum + value, 0));
  return decision;
}

describe("selection score", () => {
  it("gives a normal-length extended mix the version bonus only when that preference is saved", () => {
    const original = track({
      peer: "a-original",
      path: "@@share\\Daft Punk\\Random Access Memories\\06 Get Lucky.flac",
      sizeBytes: 28 * MIB,
      durationSeconds: 369,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    const extended = track({
      peer: "z-extended",
      path: "@@share\\Daft Punk\\Get Lucky (Extended Mix)\\Get Lucky (Extended Mix).flac",
      sizeBytes: 28 * MIB,
      durationSeconds: 420,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    const balanced = selected([original, extended], { query, versionPreference: "balanced" });
    expect(balanced.pick.peer).toBe("a-original");
    expect(balanced.breakdown.versionPreference).toBe(0);

    const on = selected([original, extended], { query, versionPreference: "extended" });
    expect(on.pick.peer).toBe("z-extended");
    expect(on.breakdown.versionPreference).toBe(SCORE_WEIGHTS.versionBasename);
    expect(on.breakdown.longRecording).toBe(0);
  });

  it("lets a requested remix dominate every other component that still passes the filters", () => {
    const album = track({
      peer: "album",
      path: "@@share\\Daft Punk\\Random Access Memories\\06 Get Lucky.flac",
      sizeBytes: 28 * MIB,
      durationSeconds: 369,
      bitDepth: 24,
      sampleRateHz: 48000,
      availability: { freeSlot: true, queueLength: 0, speedBps: 20_000_000 },
    });
    const remix = track({
      peer: "remix",
      path: "@@share\\Daft Punk\\Get Lucky (Remix)\\Get Lucky (Remix).mp3",
      sizeBytes: 8 * MIB,
      durationSeconds: 369,
      bitrateKbps: 128,
      availability: { freeSlot: false, queueLength: 400, speedBps: 1 },
    });
    const pick = selected([album, remix], { query: { artist: "Daft Punk", title: "Get Lucky Remix" } });
    expect(pick.pick.peer).toBe("remix");
    expect(pick.breakdown.requestedVersion).toBe(SCORE_WEIGHTS.requestedVersion);
    expect(pick.breakdown.requestedVersion).toBeGreaterThan(Math.abs(pick.breakdown.quality));
  });

  it("picks a good 35 MiB master over a poor or unknown 8 MiB file", () => {
    const good = track({
      peer: "good",
      path: "@@share\\Daft Punk\\Album\\Get Lucky.flac",
      sizeBytes: 35 * MIB,
      durationSeconds: 360,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    const low = track({
      peer: "low",
      path: "@@share\\Daft Punk\\Album\\Get Lucky.mp3",
      sizeBytes: 8 * MIB,
      durationSeconds: 360,
      bitrateKbps: 128,
    });
    const unknown = track({
      peer: "tiny",
      path: "@@share\\Daft Punk\\Album\\Get Lucky.mp3",
      sizeBytes: 8 * MIB,
    });
    expect(selected([good, low], { query }).pick.peer).toBe("good");
    expect(selected([good, unknown], { query }).pick.peer).toBe("good");
    expect(selected([good, low], { query }).breakdown.sizeOvershoot).toBeLessThan(0);
    expect(selected([good, low], { query }).breakdown.sizeOvershoot).toBeGreaterThan(scoreTrack(low, { query }).breakdown.quality);
    expect(scoreTrack(low, { query }).breakdown.quality).toBeLessThan(0);
    expect(scoreTrack(unknown, { query }).signals.quality).toBe("unknown");
    expect(scoreTrack(unknown, { query }).breakdown.quality).toBe(0);
  });

  it("scores 320 kbps and 16/44.1 FLAC as the same quality, then applies format and size", () => {
    const flac = track({
      peer: "flac",
      path: "@@share\\Album\\Get Lucky.flac",
      sizeBytes: 42 * MIB,
      durationSeconds: 360,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    const mp3 = track({
      peer: "mp3",
      path: "@@share\\Album\\Get Lucky.mp3",
      sizeBytes: 14 * MIB,
      durationSeconds: 360,
      bitrateKbps: 320,
    });
    const hires = track({
      peer: "hires",
      path: "@@share\\Album\\Get Lucky.flac",
      sizeBytes: 42 * MIB,
      durationSeconds: 360,
      bitDepth: 24,
      sampleRateHz: 48000,
    });
    expect(scoreTrack(flac).breakdown.quality).toBe(SCORE_WEIGHTS.qualityGood);
    expect(scoreTrack(mp3).breakdown.quality).toBe(SCORE_WEIGHTS.qualityGood);
    expect(scoreTrack(hires).breakdown.quality).toBe(SCORE_WEIGHTS.qualityGood);
    const sizeGap = scoreTrack(flac).breakdown.sizeOvershoot;
    expect(sizeGap).toBeLessThan(-SCORE_WEIGHTS.formatPreference);

    const preferMp3 = selected([flac, mp3], { formatPreference: "prefer_mp3" });
    expect(preferMp3.pick.peer).toBe("mp3");
    expect(preferMp3.breakdown.format).toBe(SCORE_WEIGHTS.formatPreference);
    expect(scoreTrack(flac, { formatPreference: "prefer_mp3" }).breakdown.format).toBe(0);

    const auto = selected([flac, mp3], { formatPreference: "auto" });
    expect(auto.pick.peer).toBe("mp3");
    expect(scoreTrack(flac, { formatPreference: "auto" }).breakdown.format).toBe(0);
    expect(scoreTrack(mp3, { formatPreference: "auto" }).total - scoreTrack(flac, { formatPreference: "auto" }).total).toBe(-sizeGap);

    const preferFlac = selected([flac, mp3], { formatPreference: "prefer_flac" });
    expect(preferFlac.pick.peer).toBe("mp3");
    expect(scoreTrack(flac, { formatPreference: "prefer_flac" }).breakdown.format).toBe(SCORE_WEIGHTS.formatPreference);

    const sameSizeFlac = track({
      peer: "same-flac",
      path: "@@share\\Album\\Get Lucky.flac",
      sizeBytes: 20 * MIB,
      durationSeconds: 360,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    const sameSizeMp3 = track({
      peer: "same-mp3",
      path: "@@share\\Album\\Get Lucky.mp3",
      sizeBytes: 14 * MIB,
      durationSeconds: 360,
      bitrateKbps: 320,
    });
    expect(scoreTrack(sameSizeFlac).breakdown.sizeOvershoot).toBe(0);
    expect(selected([sameSizeFlac, sameSizeMp3], { formatPreference: "prefer_flac" }).pick.peer).toBe("same-flac");
  });

  it("excludes a 60 min SYNTHETIC DJ set, heavily penalizes a 15 min live file, and drops unknown-duration long recordings", () => {
    const normal = track({
      peer: "normal",
      path: "@@share\\Daft Punk\\Album\\Get Lucky.flac",
      sizeBytes: 42 * MIB,
      durationSeconds: 369,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    // SYNTHETIC: this search had no recording at or above 12 minutes.
    const djSet = track({
      peer: "dj",
      path: "@@share\\SYNTHETIC DJ Set\\Get Lucky.flac",
      sizeBytes: 80 * MIB,
      durationSeconds: 60 * 60,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    const onlyLong = selectTracks([djSet], { query });
    expect(onlyLong.outcome).toBe("no_suitable_result");
    if (onlyLong.outcome === "no_suitable_result") expect(onlyLong.removed.max_duration).toBe(1);

    const live = track({
      peer: "live",
      path: "@@share\\Daft Punk\\Album\\Get Lucky (Live).flac",
      sizeBytes: 42 * MIB,
      durationSeconds: 15 * 60,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    const penalized = selected([normal, live], { query });
    expect(penalized.pick.peer).toBe("normal");
    expect(scoreTrack(live, { query }).breakdown.durationOvershoot).toBeLessThanOrEqual(-100);
    expect(scoreTrack(live, { query }).breakdown.longRecording).toBe(0);

    // SYNTHETIC unknown-duration files. The audited search had no 180 MiB audio file of this kind.
    const liveAt = track({
      peer: "live-at",
      path: "@@share\\Daft Punk\\Get Lucky.flac",
      basename: "Get Lucky.flac",
      folders: ["@@share", "Live at Madison Square Garden"],
      sizeBytes: 180 * MIB,
    });
    const radio = track({
      peer: "radio",
      path: "@@share\\Radio Show Episode 123\\Get Lucky.mp3",
      sizeBytes: 180 * MIB,
      bitrateKbps: 320,
    });
    expect(selected([normal, liveAt], { query }).pick.peer).toBe("normal");
    expect(selected([normal, radio], { query }).pick.peer).toBe("normal");
    expect(scoreTrack(liveAt, { query }).breakdown.longRecording).toBe(SCORE_WEIGHTS.longRecording);
    expect(scoreTrack(radio, { query }).breakdown.longRecording).toBe(SCORE_WEIGHTS.longRecording);
    expect(scoreTrack(liveAt, { query }).signals.quality).toBe("unknown");
  });

  it("does not treat CD1, Disc 1, Extended Mix, or Club Mix as long recordings, and does treat Mixshow", () => {
    const cd1 = track({
      peer: "cd1",
      path: "@@abcde\\Daft Punk\\Random Access Memories\\CD1\\06 Get Lucky.flac",
      sizeBytes: 42 * MIB,
      durationSeconds: 369,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    const disc = track({
      peer: "disc",
      path: "@@abcde\\Daft Punk\\Random Access Memories\\Disc 1\\06 Get Lucky.flac",
      sizeBytes: 42 * MIB,
      durationSeconds: 369,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    const cdSpaced = track({
      peer: "cd-spaced",
      path: "@@abcde\\Album\\CD 1\\06 Get Lucky.flac",
      sizeBytes: 42 * MIB,
      durationSeconds: 369,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    const extended = track({
      peer: "extended",
      path: "@@abcde\\Album\\Get Lucky (Extended Mix).flac",
      sizeBytes: 42 * MIB,
      durationSeconds: 420,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    const club = track({
      peer: "club",
      path: "@@abcde\\Album\\Get Lucky (Club Mix).flac",
      sizeBytes: 42 * MIB,
      durationSeconds: 390,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    const mixshow = track({
      peer: "mixshow",
      path: "@@abcde\\Album\\Get Lucky Mixshow.flac",
      sizeBytes: 42 * MIB,
      durationSeconds: 369,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    // SYNTHETIC: a live album folder with a normal disc folder under it must not inherit the penalty.
    const discUnderLive = track({
      peer: "nested",
      path: "@@abcde\\Live at MSG\\CD1\\06 Get Lucky.flac",
      sizeBytes: 42 * MIB,
      durationSeconds: 369,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    for (const row of [cd1, disc, cdSpaced, extended, club, discUnderLive]) {
      expect(scoreTrack(row, { query }).breakdown.longRecording).toBe(0);
    }
    expect(scoreTrack(extended, { query, versionPreference: "extended" }).breakdown.versionPreference).toBe(
      SCORE_WEIGHTS.versionBasename,
    );
    expect(scoreTrack(club, { query, versionPreference: "extended" }).breakdown.versionPreference).toBe(
      SCORE_WEIGHTS.versionBasename,
    );
    expect(scoreTrack(extended, { query, versionPreference: "extended" }).breakdown.longRecording).toBe(0);
    expect(scoreTrack(club, { query, versionPreference: "extended" }).breakdown.longRecording).toBe(0);
    expect(scoreTrack(mixshow, { query, versionPreference: "extended" }).breakdown.longRecording).toBe(
      SCORE_WEIGHTS.longRecording,
    );
    expect(scoreTrack(mixshow, { query, versionPreference: "extended" }).breakdown.versionPreference).toBe(0);
    expect(selected([cd1, mixshow], { query }).pick.peer).toBe("cd1");
    expect(selected([disc, mixshow], { query }).pick.peer).toBe("disc");
    // A configured disc phrase still does not count.
    expect(scoreTrack(cd1, { query, longRecordingPhrases: ["cd1", "disc", "mix"] }).breakdown.longRecording).toBe(0);
  });

  it("ranks stems last, even against a worse full track", () => {
    const stem = track({
      peer: "a-stem",
      path: "@@share\\Daft Punk - Get Lucky\\drums.ogg",
      sizeBytes: 8 * MIB,
      durationSeconds: 369,
      availability: { freeSlot: true, queueLength: 0, speedBps: 20_000_000 },
    });
    const full = track({
      peer: "z-full",
      path: "@@share\\Daft Punk - Get Lucky\\Get Lucky.ogg",
      sizeBytes: 8 * MIB,
      durationSeconds: 369,
      availability: { freeSlot: false, queueLength: 80, speedBps: 1 },
    });
    const pick = selected([stem, full], { query, allowedExtensions: [".ogg"] });
    expect(pick.pick.peer).toBe("z-full");
    expect(scoreTrack(stem, { query }).breakdown.stem).toBe(SCORE_WEIGHTS.stem);
    const alone = selected([stem], { query, allowedExtensions: [".ogg"] });
    expect(alone.pick.peer).toBe("a-stem");
  });

  it("breaks ties on peer, then path, and returns a stable breakdown", () => {
    const first = track({
      peer: "b",
      path: "@@share\\Album\\Get Lucky.flac",
      sizeBytes: 20 * MIB,
      durationSeconds: 200,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    const earlierPeer = track({
      peer: "a",
      path: "@@share\\Album\\Get Lucky.flac",
      sizeBytes: 20 * MIB,
      durationSeconds: 200,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    const earlierPath = track({
      peer: "a",
      path: "@@share\\Album\\A Get Lucky.flac",
      sizeBytes: 20 * MIB,
      durationSeconds: 200,
      bitDepth: 16,
      sampleRateHz: 44100,
    });
    expect(selected([first, earlierPeer]).pick.peer).toBe("a");
    expect(selected([earlierPath, earlierPeer]).pick.path).toBe(earlierPath.path);
    const again = selected([first, earlierPeer]);
    expect(again).toEqual(selected([earlierPeer, first]));
  });
});

describe("quality priority", () => {
  const floor = DEFAULT_BITRATE_FLOOR_KBPS;

  function lossy(kbps: number, extra: Partial<CandidateTrack> = {}): CandidateTrack {
    return track({
      peer: "q",
      path: "@@share\\Album\\Get Lucky.mp3",
      sizeBytes: 8 * MIB,
      durationSeconds: 360,
      bitrateKbps: kbps,
      ...extra,
    });
  }

  function qualityAt(kbps: number, extra: Partial<CandidateTrack> = {}): number {
    return scoreTrack(lossy(kbps, extra)).breakdown.quality;
  }

  function availabilityAt(availability: NonNullable<CandidateTrack["availability"]>): number {
    return scoreTrack(
      track({
        peer: "peer",
        path: "@@share\\Album\\Get Lucky.flac",
        sizeBytes: 20 * MIB,
        durationSeconds: 360,
        bitDepth: 16,
        sampleRateHz: 44100,
        availability,
      }),
    ).breakdown.availability;
  }

  function span(min: number, max: number): number {
    return max - min;
  }

  function smallestNonZeroGap(values: readonly number[]): number {
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    let gap = Number.POSITIVE_INFINITY;
    for (let i = 1; i < sorted.length; i++) {
      const step = (sorted[i] ?? 0) - (sorted[i - 1] ?? 0);
      if (step > 0 && step < gap) gap = step;
    }
    return gap;
  }

  function flacAt(sizeMb: number, extra: Partial<CandidateTrack> = {}): CandidateTrack {
    return track({
      peer: "flac",
      path: "@@share\\Album\\Get Lucky.flac",
      sizeBytes: sizeMb * MIB,
      durationSeconds: 360,
      bitDepth: 16,
      sampleRateHz: 44100,
      ...extra,
    });
  }

  it("keeps each scored tier above the ranges below it, with size dominant from 2× the preferred size", () => {
    const mismatch = selectTracks(
      [
        track({
          peer: "other-song",
          path: "@@share\\Album\\Around the World.flac",
          sizeBytes: 20 * MIB,
          durationSeconds: 300,
          bitDepth: 16,
          sampleRateHz: 44100,
        }),
      ],
      { query },
    );
    expect(mismatch.outcome).toBe("no_suitable_result");
    if (mismatch.outcome === "no_suitable_result") expect(mismatch.removed.title_mismatch).toBe(1);

    const qualityScores: number[] = [];
    for (let kbps = SCORE_WEIGHTS.bitrateVersionMin; kbps <= SCORE_WEIGHTS.bitrateGoodMax; kbps += 1) {
      qualityScores.push(qualityAt(kbps));
    }
    qualityScores.push(scoreTrack(flacAt(42)).breakdown.quality);
    const qualityMin = Math.min(...qualityScores);
    const qualityMax = Math.max(...qualityScores);
    const qualityGood = qualityAt(SCORE_WEIGHTS.bitrateGoodMax);
    const qualityAcceptable = qualityAt(floor);
    const qualityPoor = qualityAt(SCORE_WEIGHTS.bitrateVersionMin);
    const underMinScores: number[] = [];
    for (let kbps = SCORE_WEIGHTS.bitratePlausibleMin; kbps < SCORE_WEIGHTS.bitrateVersionMin; kbps += 1) {
      underMinScores.push(qualityAt(kbps));
    }

    const formatScores = [
      scoreTrack(lossy(320), { formatPreference: "prefer_mp3" }).breakdown.format,
      scoreTrack(lossy(320), { formatPreference: "auto" }).breakdown.format,
      scoreTrack(lossy(320), { formatPreference: "mp3_only" }).breakdown.format,
      scoreTrack(flacAt(14), { formatPreference: "prefer_flac" }).breakdown.format,
      scoreTrack(flacAt(14), { formatPreference: "prefer_mp3" }).breakdown.format,
    ];
    const formatMin = Math.min(...formatScores);
    const formatMax = Math.max(...formatScores);

    const hardMaxMb = DEFAULT_MAX_FILE_SIZE_MB;
    const preferredMb = DEFAULT_PREFERRED_MAX_FILE_SIZE_MB;
    const sizeAt = (sizeMb: number, preferred = preferredMb) =>
      scoreTrack(flacAt(sizeMb), { preferredMaxFileSizeMb: preferred }).breakdown.sizeOvershoot;
    const knownDurationSizes = [1, 14, preferredMb, 31, 35, 42, 45, 60, 70, 100, 140, hardMaxMb];
    const knownSizeScores = knownDurationSizes.map((sizeMb) => sizeAt(sizeMb));
    const knownSizeMin = Math.min(...knownSizeScores);
    const knownSizeMax = Math.max(...knownSizeScores);

    const steepSizeScores = [40, 70, 120, 200, 400, 800].flatMap((sizeMb) => [
      scoreTrack(flacAt(sizeMb, { durationSeconds: undefined })).breakdown.sizeOvershoot,
      scoreTrack(flacAt(sizeMb, { durationSeconds: 15 * 60 })).breakdown.sizeOvershoot,
      scoreTrack(flacAt(sizeMb, { path: "@@share\\SYNTHETIC DJ Set\\Get Lucky.flac", durationSeconds: 360 })).breakdown.sizeOvershoot,
    ]);

    const speedForCap = 10 ** (SCORE_WEIGHTS.availabilitySpeedCap + 4);
    const availabilityScores = [
      availabilityAt({ freeSlot: true, queueLength: 0, speedBps: speedForCap }),
      availabilityAt({ freeSlot: true, queueLength: 0, speedBps: 0 }),
      availabilityAt({ freeSlot: false, queueLength: 0, speedBps: 0 }),
      availabilityAt({ freeSlot: false, queueLength: SCORE_WEIGHTS.availabilityQueueStep, speedBps: 0 }),
      availabilityAt({ freeSlot: false, queueLength: SCORE_WEIGHTS.availabilityExtremeQueueAbove, speedBps: 0 }),
    ];
    // Queue equal to the extreme threshold still uses the normal cap. The −60
    // penalty applies only once the queue is over 1000. That is an abandoned
    // peer, not a queue a normal file sits in, so it is left out of this range.
    const extremeQueue = availabilityAt({
      freeSlot: false,
      queueLength: SCORE_WEIGHTS.availabilityExtremeQueueAbove + 1,
      speedBps: 0,
    });
    const availabilityMin = Math.min(...availabilityScores);
    const availabilityMax = Math.max(...availabilityScores);
    expect(extremeQueue).toBeLessThan(availabilityMin);

    const cohort = [300, 340, 360, 369, 400, 420];
    const shortScores = [1, 30, 60, 89, 105, 200, 360].map(
      (durationSeconds) => scoreTrack(flacAt(12, { durationSeconds }), { cohortDurationSeconds: cohort }).breakdown.shortRecording,
    );
    shortScores.push(scoreTrack(flacAt(12, { durationSeconds: 60 })).breakdown.shortRecording);
    const longScores = [
      scoreTrack(flacAt(42)).breakdown.longRecording,
      scoreTrack(flacAt(42, { path: "@@share\\Radio Show Episode 12\\Get Lucky.flac" })).breakdown.longRecording,
    ];

    let mildOvershoot = 0;
    let blockedOvershoot = false;
    for (let seconds = 721; seconds <= 1200; seconds += 1) {
      const row = scoreTrack(
        flacAt(40, { path: "@@share\\Album\\Get Lucky (Extended Mix).flac", durationSeconds: seconds }),
        { versionPreference: "extended" },
      );
      if (row.breakdown.versionPreference > 0) mildOvershoot = Math.min(mildOvershoot, row.breakdown.durationOvershoot);
      else if (row.breakdown.durationOvershoot < 0) blockedOvershoot = true;
    }
    expect(blockedOvershoot).toBe(true);
    expect(mildOvershoot).toBeLessThan(0);

    const basename = scoreTrack(flacAt(28, { path: "@@share\\Album\\Get Lucky (Extended Mix).flac" }), {
      versionPreference: "extended",
    }).breakdown.versionPreference;
    const secondary = scoreTrack(flacAt(28, { path: "@@share\\Album\\Get Lucky (Remix).flac" }), {
      versionPreference: "extended",
    }).breakdown.versionPreference;
    const cleanOriginal = scoreTrack(flacAt(28, { path: "@@share\\Album\\Get Lucky.flac" }), {
      query,
      versionPreference: "original",
    }).breakdown.versionPreference;
    const parentOnly = scoreTrack(
      track({
        peer: "parent",
        path: "@@share\\Get Lucky (Extended Mix)\\06.flac",
        basename: "06.flac",
        folders: ["@@share", "Get Lucky (Extended Mix)"],
        sizeBytes: 28 * MIB,
        durationSeconds: 360,
        bitDepth: 16,
        sampleRateHz: 44100,
      }),
      { versionPreference: "extended" },
    ).breakdown.versionPreference;
    const clubUnderRemix = scoreTrack(flacAt(28, { path: "@@share\\Album\\Get Lucky (Club Mix).flac" }), {
      versionPreference: "remix",
    }).breakdown.versionPreference;
    const requestedOn = scoreTrack(flacAt(28, { path: "@@share\\Album\\Get Lucky (Remix).flac" }), {
      query: { title: "Get Lucky Remix" },
    }).breakdown.requestedVersion;
    const requestedOff = scoreTrack(flacAt(28)).breakdown.requestedVersion;
    const matched = scoreTrack(flacAt(28), { query }).breakdown;
    const stemOn = scoreTrack(
      track({
        peer: "stem",
        path: "@@share\\Daft Punk - Get Lucky\\drums.ogg",
        sizeBytes: 8 * MIB,
        durationSeconds: 369,
      }),
      { query },
    ).breakdown.stem;

    const qualityRange = span(qualityMin, qualityMax);
    const fidelityGap = qualityGood - qualityAcceptable;
    const justUnderFloor = qualityAt(floor - 1);
    const poorGap = qualityAcceptable - justUnderFloor;
    const qualityStep = Math.min(fidelityGap, poorGap);
    const formatRange = span(formatMin, formatMax);
    const knownSizeRange = span(knownSizeMin, knownSizeMax);
    const availabilityRange = span(availabilityMin, availabilityMax);
    const belowQuality = formatRange + availabilityRange;
    const belowSize = qualityRange + belowQuality;
    const versionQuality = span(qualityPoor, qualityGood);
    const versionLower = versionQuality + knownSizeRange + formatRange + availabilityRange + Math.abs(mildOvershoot);
    const underMinMagnitude = Math.abs(Math.max(...underMinScores));
    const badMagnitude = Math.min(
      Math.abs(Math.min(...longScores)),
      Math.abs(Math.min(...shortScores)),
      underMinMagnitude,
    );
    const badLower = qualityRange + knownSizeRange + formatRange + availabilityRange;

    expect(qualityAt(SCORE_WEIGHTS.bitrateVersionMin - 1)).toBeLessThan(qualityPoor);
    expect(sizeAt(preferredMb)).toBe(0);
    expect(sizeAt(preferredMb * SCORE_WEIGHTS.sizeGentleUntilRatio)).toBeLessThan(0);
    expect(Math.abs(sizeAt(preferredMb * SCORE_WEIGHTS.sizeGentleUntilRatio))).toBeLessThan(qualityRange);
    expect(Math.abs(sizeAt(preferredMb * SCORE_WEIGHTS.sizeStrongFromRatio))).toBeGreaterThan(belowSize);
    expect(Math.abs(sizeAt(hardMaxMb))).toBe(knownSizeRange);
    let previousSize = 0;
    for (const sizeMb of [preferredMb + 1, 35, 45, 60, 90, 120, 160, hardMaxMb]) {
      const penalty = sizeAt(sizeMb);
      expect(penalty).toBeLessThan(previousSize);
      previousSize = penalty;
    }
    expect(sizeAt(preferredMb * SCORE_WEIGHTS.sizeStrongFromRatio * 2, preferredMb * 2)).toBe(
      sizeAt(preferredMb * SCORE_WEIGHTS.sizeStrongFromRatio),
    );
    const seventyOne = sizeAt(71);
    const twoTwoFour = sizeAt(224);
    expect(seventyOne - twoTwoFour).toBeGreaterThan(availabilityRange);
    expect(twoTwoFour).toBeLessThan(sizeAt(hardMaxMb));
    expect(Math.min(...steepSizeScores)).toBeLessThan(knownSizeMin);

    const titleMatch = scoreTrack(flacAt(28), { query: { title: "Get Lucky" } }).breakdown.titleMatch;
    const titlePath = scoreTrack(
      track({
        peer: "path-only",
        path: "@@share\\Daft Punk - Get Lucky\\06.flac",
        basename: "06.flac",
        folders: ["@@share", "Daft Punk - Get Lucky"],
        sizeBytes: 28 * MIB,
        durationSeconds: 360,
        bitDepth: 16,
        sampleRateHz: 44100,
      }),
      { query: { title: "Get Lucky" } },
    ).breakdown.titleMatch;
    const tiers: { name: string; gap: number; lower: number; dominates: boolean }[] = [
      // Title mismatches are removed before scoring. The point bonus is not what enforces the tier.
      { name: "title", gap: span(titlePath, titleMatch), lower: 0, dominates: false },
      { name: "requestedVersion", gap: span(requestedOff, requestedOn), lower: basename + badMagnitude + badLower, dominates: true },
      { name: "versionPreference", gap: smallestNonZeroGap([0, secondary, parentOnly, basename]), lower: versionLower, dominates: true },
      { name: "badResults", gap: badMagnitude, lower: badLower, dominates: true },
      { name: "size", gap: Math.abs(sizeAt(preferredMb * SCORE_WEIGHTS.sizeStrongFromRatio)), lower: belowSize, dominates: true },
      { name: "quality", gap: qualityStep, lower: belowQuality, dominates: true },
      { name: "format", gap: formatRange, lower: availabilityRange, dominates: true },
      { name: "peer", gap: availabilityRange, lower: 0, dominates: false },
    ];
    expect(tiers.map((tier) => tier.name)).toEqual([
      "title",
      "requestedVersion",
      "versionPreference",
      "badResults",
      "size",
      "quality",
      "format",
      "peer",
    ]);
    for (const tier of tiers) {
      if (!tier.dominates) continue;
      expect(tier.gap).toBeGreaterThan(tier.lower);
    }
    expect(qualityRange).toBeLessThan(Math.abs(sizeAt(preferredMb * SCORE_WEIGHTS.sizeStrongFromRatio)));

    for (const step of [basename, parentOnly, cleanOriginal, secondary, clubUnderRemix]) {
      expect(step).toBeGreaterThan(versionLower);
    }
    expect(basename - parentOnly).toBeGreaterThan(versionLower);
    expect(parentOnly - secondary).toBeGreaterThan(versionLower);
    expect(cleanOriginal).toBe(secondary);
    expect(clubUnderRemix).toBe(secondary);
    expect(Math.abs(stemOn)).toBeGreaterThan(
      requestedOn +
        Math.max(matched.titleMatch, 0) +
        Math.max(matched.artistInPath, 0) +
        basename +
        Math.max(qualityMax, 0) +
        Math.max(formatMax, 0) +
        Math.max(availabilityMax, 0),
    );
  });

  it("picks a 14.2 MiB album MP3 over a 69.9 MiB album FLAC under original and prefer_flac", () => {
    const flac = flacAt(69.9, { peer: "album-flac", path: "@@share\\Album\\Get Lucky (Album Version).flac" });
    const mp3 = lossy(320, {
      peer: "album-mp3",
      path: "@@share\\Album\\Get Lucky (Album Version).mp3",
      sizeBytes: 14.2 * MIB,
    });
    const policy = { formatPreference: "prefer_flac" as const, versionPreference: "original" as const };
    const flacScore = scoreTrack(flac, policy);
    const mp3Score = scoreTrack(mp3, policy);
    expect(flacScore.breakdown.durationOvershoot).toBe(0);
    expect(flacScore.breakdown.longRecording).toBe(0);
    expect(mp3Score.breakdown.sizeOvershoot).toBe(0);
    const qualitySpan = SCORE_WEIGHTS.qualityGood - scoreTrack(lossy(SCORE_WEIGHTS.bitrateVersionMin)).breakdown.quality;
    expect(flacScore.breakdown.sizeOvershoot).toBeLessThan(-(qualitySpan + SCORE_WEIGHTS.formatPreference));
    expect(flacScore.breakdown.format).toBeGreaterThan(0);
    expect(mp3Score.breakdown.format).toBe(0);
    expect(flacScore.breakdown.versionPreference).toBe(mp3Score.breakdown.versionPreference);
    expect(selected([flac, mp3], policy).pick.peer).toBe("album-mp3");

    const only = selected([flac], { formatPreference: "flac_only", versionPreference: "original" });
    expect(only.pick.peer).toBe("album-flac");
    expect(only.breakdown.sizeOvershoot).toBe(flacScore.breakdown.sizeOvershoot);
  });

  it("lets a 25 MiB Club Mix MP3 beat a 71.1 MiB Club Mix FLAC, and lets that FLAC beat a radio edit when it is the only club mix", () => {
    const clubMp3 = lossy(320, {
      peer: "club-mp3",
      path: "@@share\\SYNTHETIC\\Get Lucky (Club Mix).mp3",
      sizeBytes: 25 * MIB,
    });
    const clubFlac = flacAt(71.1, {
      peer: "club-flac",
      path: "@@share\\SYNTHETIC\\Get Lucky (Club Mix).flac",
      availability: { freeSlot: true, queueLength: 0, speedBps: 10 ** (SCORE_WEIGHTS.availabilitySpeedCap + 4) },
    });
    const extendedFlac = { versionPreference: "extended" as const, formatPreference: "prefer_flac" as const };
    expect(selected([clubMp3, clubFlac], extendedFlac).pick.peer).toBe("club-mp3");

    const radio = lossy(320, {
      peer: "radio-mp3",
      path: "@@share\\SYNTHETIC\\Get Lucky (Radio Edit).mp3",
      sizeBytes: 10 * MIB,
      availability: { freeSlot: true, queueLength: 0, speedBps: 10 ** (SCORE_WEIGHTS.availabilitySpeedCap + 4) },
    });
    const onlyLarge = flacAt(70, {
      peer: "only-club-flac",
      path: "@@share\\SYNTHETIC\\Get Lucky (Club Mix).flac",
      availability: { freeSlot: false, queueLength: SCORE_WEIGHTS.availabilityQueueCap * SCORE_WEIGHTS.availabilityQueueStep, speedBps: 1 },
    });
    const extended = { versionPreference: "extended" as const };
    expect(selected([onlyLarge, radio], extended).pick.peer).toBe("only-club-flac");
    expect(scoreTrack(onlyLarge, extended).breakdown.versionPreference).toBe(SCORE_WEIGHTS.versionBasename);
    expect(scoreTrack(radio, extended).breakdown.versionPreference).toBe(0);

    const midClub = flacAt(40, {
      peer: "mid-club",
      path: "@@share\\SYNTHETIC\\Get Lucky (Club Mix).flac",
    });
    const smallRadio = lossy(320, {
      peer: "small-radio",
      path: "@@share\\SYNTHETIC\\Get Lucky (Radio Edit).mp3",
      sizeBytes: 10 * MIB,
    });
    expect(selected([midClub, smallRadio], extended).pick.peer).toBe("mid-club");
    expect(scoreTrack(midClub, extended).breakdown.sizeOvershoot).toBeLessThan(0);
    expect(scoreTrack(midClub, extended).breakdown.sizeOvershoot).toBeGreaterThan(
      -SCORE_WEIGHTS.versionBasename,
    );
  });

  it("lets a normal-size extended MP3 beat a 65 MiB FLAC radio edit under every format except flac_only", () => {
    const extendedMp3 = lossy(320, {
      peer: "ext-mp3",
      path: "@@share\\SYNTHETIC\\Get Lucky (Extended Mix).mp3",
      sizeBytes: 18 * MIB,
    });
    const radioFlac = flacAt(65, {
      peer: "radio-flac",
      path: "@@share\\SYNTHETIC\\Get Lucky (Radio Edit).flac",
      availability: { freeSlot: true, queueLength: 0, speedBps: 10 ** (SCORE_WEIGHTS.availabilitySpeedCap + 4) },
    });
    const extended = { versionPreference: "extended" as const };
    for (const formatPreference of ["auto", "prefer_mp3", "prefer_flac", "mp3_only"] as const) {
      const pick = selected([extendedMp3, radioFlac], { ...extended, formatPreference });
      expect(pick.pick.peer).toBe("ext-mp3");
      expect(pick.pick.format.ext).toBe(".mp3");
    }
    const onlyFlac = selected([extendedMp3, radioFlac], { ...extended, formatPreference: "flac_only" });
    expect(onlyFlac.pick.peer).toBe("radio-flac");
    expect(onlyFlac.pick.format.ext).toBe(".flac");
    expect(onlyFlac.breakdown.sizeOvershoot).toBeLessThan(0);
  });

  it("lets a 14 MiB 128 kbps MP3 beat a 70 MiB FLAC of the same version, and keeps under 128 in the bad tier", () => {
    const poor = lossy(128, {
      peer: "poor-mp3",
      path: "@@share\\Album\\Get Lucky (Album Version).mp3",
      sizeBytes: 14 * MIB,
    });
    const huge = flacAt(70, {
      peer: "huge-flac",
      path: "@@share\\Album\\Get Lucky (Album Version).flac",
      availability: { freeSlot: true, queueLength: 0, speedBps: 10 ** (SCORE_WEIGHTS.availabilitySpeedCap + 4) },
    });
    const policy = { versionPreference: "original" as const, formatPreference: "prefer_flac" as const };
    expect(selected([poor, huge], policy).pick.peer).toBe("poor-mp3");
    expect(scoreTrack(poor, policy).breakdown.versionPreference).toBeGreaterThan(0);
    expect(scoreTrack(huge, policy).breakdown.sizeOvershoot).toBeLessThan(scoreTrack(poor, policy).breakdown.quality - SCORE_WEIGHTS.qualityGood);

    const under = lossy(96, {
      peer: "under-mp3",
      path: "@@share\\Album\\Get Lucky (Album Version).mp3",
      sizeBytes: 10 * MIB,
    });
    expect(scoreTrack(under, policy).breakdown.versionPreference).toBe(0);
    expect(scoreTrack(under, policy).breakdown.quality).toBeLessThan(-Math.abs(scoreTrack(huge, policy).breakdown.sizeOvershoot));
    expect(selected([under, huge], policy).pick.peer).toBe("huge-flac");
  });

  it("prefers a normal-size 192 kbps MP3 over a 42 MiB FLAC under prefer_mp3", () => {
    const mp3 = lossy(floor, {
      peer: "fast-mp3",
      availability: { freeSlot: true, queueLength: 0, speedBps: 10 ** (SCORE_WEIGHTS.availabilitySpeedCap + 4) },
    });
    const flac = track({
      peer: "queued-flac",
      path: "@@share\\Album\\Get Lucky.flac",
      sizeBytes: 42 * MIB,
      durationSeconds: 360,
      bitDepth: 16,
      sampleRateHz: 44100,
      availability: { freeSlot: false, queueLength: SCORE_WEIGHTS.availabilityQueueCap * SCORE_WEIGHTS.availabilityQueueStep, speedBps: 1 },
    });
    const policy = { formatPreference: "prefer_mp3" as const };
    const mp3Score = scoreTrack(mp3, policy);
    const flacScore = scoreTrack(flac, policy);
    expect(mp3Score.breakdown.quality).toBe(SCORE_WEIGHTS.qualityAcceptable);
    expect(flacScore.breakdown.quality).toBe(SCORE_WEIGHTS.qualityGood);
    expect(mp3Score.breakdown.format).toBe(SCORE_WEIGHTS.formatPreference);
    expect(flacScore.breakdown.format).toBe(0);
    expect(mp3Score.breakdown.availability).toBeGreaterThan(flacScore.breakdown.availability);
    expect(flacScore.breakdown.sizeOvershoot).toBeLessThan(-SCORE_WEIGHTS.formatPreference);
    expect(selected([mp3, flac], policy).pick.peer).toBe("fast-mp3");
  });

  it("penalizes a SYNTHETIC short remix and still lets an explicit request win", () => {
    const fillers = [300, 340, 369, 400, 420].map((durationSeconds, index) =>
      flacAt(40, { peer: `fill-${index}`, durationSeconds }),
    );
    const short = flacAt(12, {
      peer: "SYNTHETIC-short",
      path: "@@share\\SYNTHETIC\\Get Lucky (HOME Remix).flac",
      durationSeconds: 105,
    });
    const full = flacAt(42, {
      peer: "full-remix",
      path: "@@share\\Album\\Get Lucky (Remix).flac",
      durationSeconds: 369,
    });
    const saved = selected([short, full, ...fillers], {
      query,
      versionPreference: "remix",
      formatPreference: "prefer_flac",
    });
    expect(saved.pick.peer).toBe("full-remix");
    expect(saved.breakdown.shortRecording).toBe(0);

    const requested = selected([short, ...fillers], {
      query: { artist: "Daft Punk", title: "Get Lucky Remix" },
      formatPreference: "prefer_flac",
    });
    expect(requested.pick.peer).toBe("SYNTHETIC-short");
    expect(requested.breakdown.requestedVersion).toBe(SCORE_WEIGHTS.requestedVersion);
    expect(requested.breakdown.shortRecording).toBeLessThan(0);
  });

  it("lets style beat fidelity, and lets format decide only inside one style", () => {
    const clubMp3 = lossy(320, {
      peer: "club-mp3",
      path: "@@share\\SYNTHETIC\\Get Lucky (Club Mix).mp3",
      sizeBytes: 14 * MIB,
      availability: { freeSlot: true, queueLength: 0, speedBps: 10 ** (SCORE_WEIGHTS.availabilitySpeedCap + 4) },
    });
    const radioFlac = flacAt(40, {
      peer: "radio-flac",
      path: "@@share\\SYNTHETIC\\Get Lucky (Radio Edit).flac",
      availability: { freeSlot: false, queueLength: 100, speedBps: 1 },
    });
    const poorClub = lossy(160, {
      peer: "poor-club",
      path: "@@share\\SYNTHETIC\\Get Lucky (Club Mix).mp3",
      sizeBytes: 8 * MIB,
    });
    const radio320 = lossy(320, {
      peer: "radio-320",
      path: "@@share\\SYNTHETIC\\Get Lucky (Radio Edit).mp3",
    });
    const clubFlac = flacAt(71, {
      peer: "club-flac",
      path: "@@share\\SYNTHETIC\\Get Lucky (Club Mix).flac",
      availability: { freeSlot: false, queueLength: SCORE_WEIGHTS.availabilityQueueCap * SCORE_WEIGHTS.availabilityQueueStep, speedBps: 1 },
    });
    const extended = { versionPreference: "extended" as const };
    for (const formatPreference of ["auto", "prefer_mp3", "prefer_flac", "mp3_only"] as const) {
      expect(selected([clubMp3, radioFlac], { ...extended, formatPreference }).pick.peer).toBe("club-mp3");
    }
    expect(selected([clubMp3, radioFlac], { ...extended, formatPreference: "flac_only" }).pick.peer).toBe("radio-flac");
    expect(selected([poorClub, radio320], extended).pick.peer).toBe("poor-club");
    expect(scoreTrack(poorClub, extended).breakdown.quality).toBeLessThan(0);
    expect(scoreTrack(poorClub, extended).breakdown.versionPreference).toBe(SCORE_WEIGHTS.versionBasename);

    expect(selected([clubMp3, clubFlac], { ...extended, formatPreference: "prefer_flac" }).pick.peer).toBe("club-mp3");
    expect(selected([clubMp3, clubFlac], { ...extended, formatPreference: "prefer_mp3" }).pick.peer).toBe("club-mp3");
    expect(selected([clubFlac], { ...extended, formatPreference: "flac_only" }).pick.peer).toBe("club-flac");

    const tooPoor = lossy(96, { peer: "too-poor", path: "@@share\\SYNTHETIC\\Get Lucky (Club Mix).mp3" });
    expect(scoreTrack(tooPoor, extended).breakdown.versionPreference).toBe(0);
    expect(selected([tooPoor, radio320], extended).pick.peer).toBe("radio-320");

    const dj = flacAt(80, {
      peer: "SYNTHETIC-dj",
      path: "@@share\\SYNTHETIC DJ Set\\Get Lucky (Remix).flac",
      durationSeconds: 50 * 60,
    });
    const fullRemix = flacAt(40, { peer: "full-remix", path: "@@share\\Album\\Get Lucky (Remix).flac" });
    expect(scoreTrack(dj, { versionPreference: "remix" }).breakdown.versionPreference).toBe(0);
    expect(scoreTrack(dj, { versionPreference: "remix" }).breakdown.longRecording).toBe(SCORE_WEIGHTS.longRecording);
    const fillers = [300, 340, 369, 400, 420].map((durationSeconds, index) =>
      flacAt(30, { peer: `len-${index}`, durationSeconds }),
    );
    const fragment = flacAt(8, {
      peer: "SYNTHETIC-fragment",
      path: "@@share\\SYNTHETIC\\Get Lucky (Remix).flac",
      durationSeconds: 75,
    });
    const fragmentPick = selected([fragment, fullRemix, ...fillers], { versionPreference: "remix", formatPreference: "prefer_flac" });
    expect(fragmentPick.pick.peer).toBe("full-remix");
    expect(scoreTrack(fragment, { versionPreference: "remix", cohortDurationSeconds: [75, 369, 300, 340, 400, 420] }).breakdown.versionPreference).toBe(0);
    expect(scoreTrack(fragment, { versionPreference: "remix", cohortDurationSeconds: [75, 369, 300, 340, 400, 420] }).breakdown.shortRecording).toBeLessThan(0);

    const thirteen = flacAt(48, {
      peer: "thirteen",
      path: "@@share\\Album\\Get Lucky (Extended Mix).flac",
      durationSeconds: 13 * 60,
    });
    const thirteenScore = scoreTrack(thirteen, extended);
    expect(thirteenScore.breakdown.durationOvershoot).toBeLessThan(0);
    expect(thirteenScore.breakdown.versionPreference).toBe(SCORE_WEIGHTS.versionBasename);
    expect(thirteenScore.breakdown.longRecording).toBe(0);
    expect(selected([thirteen, radioFlac], extended).pick.peer).toBe("thirteen");
  });

  it("drops the saved preference when the request names a version", () => {
    // SYNTHETIC: the curated 75 has no "Radio Edit - WBBL Remix" hybrid.
    const pure = lossy(320, {
      peer: "pure-radio",
      path: "@@share\\Album\\Get Lucky (Radio Edit).mp3",
      sizeBytes: 8 * MIB,
    });
    const hybrid = lossy(320, {
      peer: "SYNTHETIC-wbbl",
      path: "@@share\\SYNTHETIC\\Get Lucky (Radio Edit - WBBL Remix).mp3",
      sizeBytes: 8 * MIB,
      availability: { freeSlot: false, queueLength: 0, speedBps: 1 },
    });
    const radioRequest = {
      query: { artist: "Daft Punk", title: "Get Lucky (Radio Edit)" },
      versionPreference: "extended" as const,
    };
    const pureScore = scoreTrack(pure, radioRequest);
    const hybridScore = scoreTrack(hybrid, radioRequest);
    expect(pureScore.breakdown.requestedVersion).toBe(SCORE_WEIGHTS.requestedVersion);
    expect(hybridScore.breakdown.requestedVersion).toBe(0);
    expect(pureScore.breakdown.versionPreference).toBe(0);
    expect(hybridScore.breakdown.versionPreference).toBe(0);
    expect(scoreTrack(hybrid, { versionPreference: "remix" }).breakdown.versionPreference).toBe(SCORE_WEIGHTS.versionBasename);
    expect(scoreTrack(hybrid, { versionPreference: "radio_edit" }).breakdown.versionPreference).toBe(0);
    expect(scoreTrack(hybrid, { versionPreference: "extended" }).breakdown.versionPreference).toBe(SCORE_WEIGHTS.versionSecondary);
    expect(hybridScore.total).toBeLessThan(pureScore.total);
    expect(selected([pure, hybrid], radioRequest).pick.peer).toBe("pure-radio");

    const album = lossy(320, {
      peer: "album",
      path: "@@share\\Album\\Get Lucky (Album Version).mp3",
      sizeBytes: 8 * MIB,
    });
    const remix = lossy(320, {
      peer: "named-remix",
      path: "@@share\\SYNTHETIC\\Get Lucky (Album Version Remix).mp3",
      sizeBytes: 8 * MIB,
      availability: { freeSlot: false, queueLength: 0, speedBps: 1 },
    });
    const originalRequest = {
      query: { artist: "Daft Punk", title: "Get Lucky (Album Version)" },
      versionPreference: "remix" as const,
    };
    const albumScore = scoreTrack(album, originalRequest);
    const remixScore = scoreTrack(remix, originalRequest);
    expect(albumScore.breakdown.requestedVersion).toBe(SCORE_WEIGHTS.requestedVersion);
    expect(remixScore.breakdown.requestedVersion).toBe(0);
    expect(albumScore.breakdown.versionPreference).toBe(0);
    expect(remixScore.breakdown.versionPreference).toBe(0);
    expect(scoreTrack(remix, { versionPreference: "remix" }).breakdown.versionPreference).toBe(SCORE_WEIGHTS.versionBasename);
    expect(remixScore.total).toBeLessThan(albumScore.total);
    expect(selected([album, remix], originalRequest).pick.peer).toBe("album");

    const plainRemix = lossy(320, {
      peer: "plain-remix",
      path: "@@share\\Album\\Get Lucky (Remix).mp3",
      sizeBytes: 8 * MIB,
      availability: { freeSlot: true, queueLength: 0, speedBps: 10 ** (SCORE_WEIGHTS.availabilitySpeedCap + 4) },
    });
    const plainScore = scoreTrack(plainRemix, originalRequest);
    expect(plainScore.breakdown.requestedVersion).toBe(0);
    expect(plainScore.breakdown.versionPreference).toBe(0);
    expect(scoreTrack(plainRemix, { versionPreference: "remix" }).breakdown.versionPreference).toBe(SCORE_WEIGHTS.versionBasename);
    expect(selected([album, plainRemix], originalRequest).pick.peer).toBe("album");
  });

  it("classifies a derived marker ahead of original and radio edit", () => {
    const marks = (value: string) => classifyVersionText(normalizeMatchText(value));
    expect(marks("Get Lucky (Original Mix)")).toMatchObject({ original: true, remix: false, radio_edit: false, extended: false });
    expect(marks("Get Lucky (Album Version)")).toMatchObject({ original: true, remix: false, radio_edit: false });
    expect(marks("Get Lucky (Extended Mix)")).toMatchObject({ extended: true, remix: false, original: false, radio_edit: false });
    expect(marks("Get Lucky (Radio Edit)")).toMatchObject({ radio_edit: true, remix: false, original: false, extended: false });
    expect(marks("Get Lucky (Club Mix)")).toMatchObject({ extended: true, remix: false, original: false, radio_edit: false });

    const vocalClub = marks("Get lucky [dark intensity original vocal club remix edit]");
    expect(vocalClub).toMatchObject({ remix: true, original: false, radio_edit: false });
    const wbbl = marks("Get Lucky (Radio Edit - WBBL Remix)");
    expect(wbbl).toMatchObject({ remix: true, radio_edit: false, original: false });
    expect(marks("Get Lucky (Album Version Remix)")).toMatchObject({ remix: true, original: false, radio_edit: false });
    expect(marks("Get Lucky (97 Steps Edit)")).toMatchObject({ remix: true, radio_edit: false, original: false });
    expect(marks("Get Lucky (Astre Edit)")).toMatchObject({ remix: true, radio_edit: false, original: false });
    expect(marks("Get Lucky (Original Club Mix)")).toMatchObject({ extended: true, original: false, radio_edit: false, remix: false });

    const steps = lossy(320, {
      peer: "steps",
      path: "@@share\\SYNTHETIC\\Get Lucky (97 Steps Edit).mp3",
      sizeBytes: 8 * MIB,
      availability: { freeSlot: true, queueLength: 0, speedBps: 10 ** (SCORE_WEIGHTS.availabilitySpeedCap + 4) },
    });
    const astre = lossy(320, {
      peer: "astre",
      path: "@@share\\SYNTHETIC\\Get Lucky (Astre Edit).mp3",
      sizeBytes: 8 * MIB,
      availability: { freeSlot: true, queueLength: 0, speedBps: 10 ** (SCORE_WEIGHTS.availabilitySpeedCap + 4) },
    });
    const radio = lossy(128, {
      peer: "real-radio",
      path: "@@share\\Album\\Get Lucky (Radio Edit).mp3",
      sizeBytes: 6 * MIB,
      availability: { freeSlot: false, queueLength: 200, speedBps: 1 },
    });
    const radioRequest = {
      query: { artist: "Daft Punk", title: "Get Lucky (Radio Edit)" },
      versionPreference: "remix" as const,
    };
    expect(selected([steps, astre, radio], { versionPreference: "radio_edit" }).pick.peer).toBe("real-radio");
    const requested = selected([steps, astre, radio], radioRequest);
    expect(requested.pick.peer).toBe("real-radio");
    expect(requested.breakdown.requestedVersion).toBe(SCORE_WEIGHTS.requestedVersion);
    expect(scoreTrack(steps, { versionPreference: "remix" }).breakdown.versionPreference).toBe(SCORE_WEIGHTS.versionBasename);
    expect(scoreTrack(astre, { versionPreference: "radio_edit" }).breakdown.versionPreference).toBe(0);
    expect(scoreTrack(steps, radioRequest).breakdown.requestedVersion).toBe(0);
  });

  it("prefers a 71 MiB Club Mix FLAC on a slower peer over a 224 MiB Club Mix FLAC on a free fast peer", () => {
    const slow = {
      freeSlot: false as const,
      queueLength: SCORE_WEIGHTS.availabilityQueueCap * SCORE_WEIGHTS.availabilityQueueStep,
      speedBps: 1,
    };
    const fast = {
      freeSlot: true as const,
      queueLength: 0,
      speedBps: 10 ** (SCORE_WEIGHTS.availabilitySpeedCap + 4),
    };
    const small = flacAt(71, {
      peer: "small-flac",
      path: "@@share\\Album\\Get Lucky (Club Mix).flac",
      availability: slow,
    });
    const huge = flacAt(224, {
      peer: "hires-flac",
      path: "@@share\\Album\\Get Lucky (Club Mix).flac",
      availability: fast,
    });
    const open = { maxFileSizeMb: null, versionPreference: "extended" as const };
    for (const formatPreference of ["prefer_flac", "flac_only"] as const) {
      expect(selected([small, huge], { ...open, formatPreference }).pick.peer).toBe("small-flac");
    }
    const smallScore = scoreTrack(small, open);
    const hugeScore = scoreTrack(huge, open);
    expect(smallScore.breakdown.quality).toBe(hugeScore.breakdown.quality);
    expect(smallScore.breakdown.versionPreference).toBe(hugeScore.breakdown.versionPreference);
    expect(hugeScore.breakdown.availability).toBeGreaterThan(smallScore.breakdown.availability);
    expect(smallScore.breakdown.sizeOvershoot - hugeScore.breakdown.sizeOvershoot).toBeGreaterThan(
      hugeScore.breakdown.availability - smallScore.breakdown.availability,
    );
  });

  it("scores reported MP3 VBR at the VBR threshold as good and leaves other formats and CBR below 256 acceptable", () => {
    const vbrMin = SCORE_WEIGHTS.bitrateVbrGoodMin;
    expect(qualityAt(vbrMin, { vbr: true })).toBe(SCORE_WEIGHTS.qualityGood);
    expect(qualityAt(239, { vbr: true })).toBe(SCORE_WEIGHTS.qualityGood);
    expect(qualityAt(240, { vbr: true })).toBe(SCORE_WEIGHTS.qualityGood);
    expect(qualityAt(vbrMin - 1, { vbr: true })).toBe(SCORE_WEIGHTS.qualityAcceptable);
    expect(qualityAt(189, { vbr: true })).toBeLessThan(SCORE_WEIGHTS.qualityAcceptable);
    expect(qualityAt(vbrMin, { vbr: false })).toBe(SCORE_WEIGHTS.qualityAcceptable);
    expect(qualityAt(239)).toBe(SCORE_WEIGHTS.qualityAcceptable);
    expect(qualityAt(vbrMin, { vbr: true, path: "@@share\\Album\\Get Lucky.ogg" })).toBe(SCORE_WEIGHTS.qualityAcceptable);
    expect(qualityAt(240, { vbr: true, path: "@@share\\Album\\Get Lucky.m4a" })).toBe(SCORE_WEIGHTS.qualityAcceptable);
    expect(qualityAt(SCORE_WEIGHTS.bitrateGoodMin)).toBe(SCORE_WEIGHTS.qualityGood);
    expect(qualityAt(SCORE_WEIGHTS.bitrateGoodMin - 1)).toBe(SCORE_WEIGHTS.qualityAcceptable);
  });
});
