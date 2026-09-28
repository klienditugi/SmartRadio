import { DEFAULT_BITRATE_FLOOR_KBPS, DEFAULT_PREFERRED_MAX_FILE_SIZE_MB } from "@subwave-ai/shared";
import { describe, expect, it } from "vitest";
import { SCORE_WEIGHTS, scoreTrack, selectTracks, type CandidateTrack } from "./index.js";

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
    expect(selected([good, low], { query }).breakdown.sizeOvershoot).toBeGreaterThan(-10);
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
    expect(scoreTrack(flac).breakdown.sizeOvershoot).toBe(-5);

    const preferMp3 = selected([flac, mp3], { formatPreference: "prefer_mp3" });
    expect(preferMp3.pick.peer).toBe("mp3");
    expect(preferMp3.breakdown.format).toBe(SCORE_WEIGHTS.formatPreference);
    expect(scoreTrack(flac, { formatPreference: "prefer_mp3" }).breakdown.format).toBe(0);

    const auto = selected([flac, mp3], { formatPreference: "auto" });
    expect(auto.pick.peer).toBe("mp3");
    expect(scoreTrack(flac, { formatPreference: "auto" }).breakdown.format).toBe(0);
    expect(scoreTrack(mp3, { formatPreference: "auto" }).total - scoreTrack(flac, { formatPreference: "auto" }).total).toBe(5);

    const preferFlac = selected([flac, mp3], { formatPreference: "prefer_flac" });
    expect(preferFlac.pick.peer).toBe("flac");
    expect(preferFlac.breakdown.format).toBe(SCORE_WEIGHTS.formatPreference);
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

  it("keeps each priority tier strictly above the ranges below it", () => {
    const qualityScores: number[] = [];
    for (let kbps = SCORE_WEIGHTS.bitratePlausibleMin; kbps <= SCORE_WEIGHTS.bitrateGoodMax; kbps += 1) {
      qualityScores.push(qualityAt(kbps));
    }
    qualityScores.push(scoreTrack(flacAt(42)).breakdown.quality);
    const qualityMin = Math.min(...qualityScores);
    const qualityMax = Math.max(...qualityScores);
    const qualityGood = qualityAt(SCORE_WEIGHTS.bitrateGoodMax);
    const qualityAcceptable = qualityAt(floor);
    const qualityPoor = qualityAt(128);

    const formatScores = [
      scoreTrack(lossy(320), { formatPreference: "prefer_mp3" }).breakdown.format,
      scoreTrack(lossy(320), { formatPreference: "auto" }).breakdown.format,
      scoreTrack(lossy(320), { formatPreference: "mp3_only" }).breakdown.format,
      scoreTrack(flacAt(14), { formatPreference: "prefer_flac" }).breakdown.format,
      scoreTrack(flacAt(14), { formatPreference: "prefer_mp3" }).breakdown.format,
    ];
    const formatMin = Math.min(...formatScores);
    const formatMax = Math.max(...formatScores);

    const knownDurationSizes = [1, 14, 30, 31, 42, 60, 70, 100, 140, 200, 400, 800];
    const knownSizeScores = knownDurationSizes.map(
      (sizeMb) => scoreTrack(flacAt(sizeMb)).breakdown.sizeOvershoot,
    );
    const knownSizeMin = Math.min(...knownSizeScores);
    const knownSizeMax = Math.max(...knownSizeScores);

    const steepSizeScores = [40, 70, 120, 200, 400, 800].map((sizeMb) => {
      const unknownDuration = scoreTrack(flacAt(sizeMb, { durationSeconds: undefined })).breakdown.sizeOvershoot;
      const overshooting = scoreTrack(flacAt(sizeMb, { durationSeconds: 15 * 60 })).breakdown.sizeOvershoot;
      const longPhrase = scoreTrack(
        flacAt(sizeMb, { path: "@@share\\SYNTHETIC DJ Set\\Get Lucky.flac", durationSeconds: 360 }),
      ).breakdown.sizeOvershoot;
      return Math.min(unknownDuration, overshooting, longPhrase);
    });

    const speedForCap = 10 ** (SCORE_WEIGHTS.availabilitySpeedCap + 4);
    const availabilityScores = [
      availabilityAt({ freeSlot: true, queueLength: 0, speedBps: speedForCap }),
      availabilityAt({ freeSlot: true, queueLength: 0, speedBps: 0 }),
      availabilityAt({ freeSlot: false, queueLength: 0, speedBps: 0 }),
      availabilityAt({ freeSlot: false, queueLength: SCORE_WEIGHTS.availabilityQueueStep, speedBps: 0 }),
      availabilityAt({
        freeSlot: false,
        queueLength: SCORE_WEIGHTS.availabilityExtremeQueueAbove,
        speedBps: 0,
      }),
    ];
    // Queue equal to the extreme threshold still uses the normal cap. The −60
    // penalty applies only once the queue is over 1000. That is an abandoned
    // peer, not a queue a normal file sits in, so it is left out of this range.
    // Folding it in would let one outlier overturn a quality tier.
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
      (durationSeconds) =>
        scoreTrack(flacAt(12, { durationSeconds }), { cohortDurationSeconds: cohort }).breakdown.shortRecording,
    );
    const aloneShort = scoreTrack(flacAt(12, { durationSeconds: 60 })).breakdown.shortRecording;
    const aloneNormal = scoreTrack(flacAt(12, { durationSeconds: 105 })).breakdown.shortRecording;
    shortScores.push(aloneShort, aloneNormal);
    const longScores = [
      scoreTrack(flacAt(42, { path: "@@share\\Album\\Get Lucky.flac" })).breakdown.longRecording,
      scoreTrack(flacAt(42, { path: "@@share\\Radio Show Episode 12\\Get Lucky.flac" })).breakdown.longRecording,
    ];
    const durationScores = [400, 720, 721, 900, 1200, 1800].map(
      (durationSeconds) => scoreTrack(flacAt(42, { durationSeconds })).breakdown.durationOvershoot,
    );

    const matched = scoreTrack(flacAt(28), { query }).breakdown;
    const requestedOn = scoreTrack(flacAt(28, { path: "@@share\\Album\\Get Lucky (Remix).flac" }), {
      query: { title: "Get Lucky Remix" },
    }).breakdown.requestedVersion;
    const requestedOff = scoreTrack(flacAt(28)).breakdown.requestedVersion;
    const versionOn = scoreTrack(flacAt(28, { path: "@@share\\Album\\Get Lucky (Extended Mix).flac" }), {
      versionPreference: "extended",
    }).breakdown.versionPreference;
    const versionOff = scoreTrack(flacAt(28, { path: "@@share\\Album\\Get Lucky (Extended Mix).flac" }), {
      versionPreference: "balanced",
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
    const stemOn = scoreTrack(
      track({
        peer: "stem",
        path: "@@share\\Daft Punk - Get Lucky\\drums.ogg",
        sizeBytes: 8 * MIB,
        durationSeconds: 369,
      }),
      { query },
    ).breakdown.stem;
    const stemOff = scoreTrack(flacAt(28), { query }).breakdown.stem;

    const qualityRange = span(qualityMin, qualityMax);
    const formatRange = span(formatMin, formatMax);
    const knownSizeRange = span(knownSizeMin, knownSizeMax);
    const availabilityRange = span(availabilityMin, availabilityMax);
    const belowFormat = knownSizeRange + availabilityRange;
    const belowQuality = formatRange + belowFormat;
    const belowVersion = qualityRange + belowQuality;

    expect(formatRange).toBeGreaterThan(knownSizeRange);
    expect(Math.min(...steepSizeScores)).toBeLessThan(knownSizeMin);

    const durationFloor = Math.max(Math.min(...longScores), Math.min(...shortScores));
    const tiers: { name: string; values: number[]; lower: number }[] = [
      {
        name: "requestedVersion",
        values: [requestedOff, requestedOn],
        lower: span(versionOff, versionOn) + belowVersion,
      },
      {
        name: "versionPreference",
        values: [versionOff, versionOn],
        lower: belowVersion,
      },
      {
        // Long-recording, short-recording, duration overshoot, and the steep size
        // curve (unknown duration or a long/overshooting file) are one tier.
        // The check uses the less severe of the long and short extremes, so a
        // one-point difference between those two penalties is not a lower tier.
        name: "duration",
        values: [0, durationFloor],
        lower: belowVersion,
      },
      {
        name: "quality",
        values: [qualityGood, qualityAcceptable, qualityPoor],
        lower: belowQuality,
      },
      {
        name: "stem",
        values: [stemOff, stemOn],
        lower:
          Math.max(requestedOn, 0) +
          Math.max(matched.titleMatch, 0) +
          Math.max(matched.artistInPath, 0) +
          Math.max(versionOn, 0) +
          Math.max(qualityMax, 0) +
          Math.max(formatMax, 0) +
          Math.max(availabilityMax, 0),
      },
    ];

    for (const tier of tiers) {
      const gap = smallestNonZeroGap(tier.values);
      expect(gap).toBeGreaterThan(tier.lower);
    }

    const durationGap = Math.min(Math.abs(Math.min(...longScores)), Math.abs(Math.min(...shortScores)));
    expect(durationGap).toBeGreaterThan(span(versionOff, versionOn));

    // Known exception. The clean-original and parent-folder steps do not clear
    // the quality range plus format, known-duration size, and a normal peer.
    for (const partial of [cleanOriginal, parentOnly]) {
      expect(partial).toBeGreaterThan(0);
      expect(partial).toBeLessThan(versionOn);
      expect(partial).toBeLessThanOrEqual(belowVersion);
    }
  });

  it("lets a known-duration 70 MiB FLAC beat a comparable MP3 under prefer_flac", () => {
    const flac = flacAt(70, { peer: "album-flac", path: "@@share\\Album\\Get Lucky (Album Version).flac" });
    const mp3 = lossy(320, {
      peer: "album-mp3",
      path: "@@share\\Album\\Get Lucky (Album Version).mp3",
      sizeBytes: 14 * MIB,
    });
    const policy = { formatPreference: "prefer_flac" as const, versionPreference: "original" as const };
    const flacScore = scoreTrack(flac, policy);
    const mp3Score = scoreTrack(mp3, policy);
    const formatGap =
      scoreTrack(mp3, { formatPreference: "prefer_mp3" }).breakdown.format -
      scoreTrack(mp3, { formatPreference: "auto" }).breakdown.format;
    expect(flacScore.breakdown.durationOvershoot).toBe(0);
    expect(flacScore.breakdown.longRecording).toBe(0);
    expect(flacScore.breakdown.sizeOvershoot).toBeLessThan(0);
    expect(flacScore.breakdown.sizeOvershoot).toBeGreaterThan(-formatGap);
    expect(flacScore.breakdown.format).toBeGreaterThan(0);
    expect(mp3Score.breakdown.format).toBe(0);
    expect(selected([flac, mp3], policy).pick.peer).toBe("album-flac");

    const only = selected([flac], { formatPreference: "flac_only" });
    expect(only.pick.peer).toBe("album-flac");
    expect(only.breakdown.sizeOvershoot).toBe(flacScore.breakdown.sizeOvershoot);
    expect(only.breakdown.sizeOvershoot).toBeGreaterThan(-formatGap);
  });

  it("prefers a 42 MiB 16/44.1 FLAC on a queued peer over a 192 kbps MP3 on a fast free peer under prefer_mp3", () => {
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
    expect(flacScore.breakdown.sizeOvershoot).toBeLessThan(0);
    expect(selected([mp3, flac], policy).pick.peer).toBe("queued-flac");
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
