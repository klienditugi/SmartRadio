import { describe, expect, it } from "vitest";
import { isSearchComplete, selectSearch, selectSearchResult } from "./select.js";

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

  it("treats Completed, ResponseLimitReached as complete", () => {
    expect(isSearchComplete({ isComplete: true, state: "Completed, ResponseLimitReached" })).toBe(true);
    expect(isSearchComplete({ state: "Completed, ResponseLimitReached" })).toBe(true);
  });
});

const MIB = 1024 * 1024;
const AUDIO = [".flac", ".mp3", ".m4a", ".ogg", ".wav"] as const;
const ALBUM = "\\\\music\\\\Daft Punk\\\\Random Access Memories\\\\06 Get Lucky.flac";
const REMIX = "\\\\music\\\\Daft Punk\\\\Get Lucky (Remix)\\\\Get Lucky (Club Remix).flac";
const HUGE = "\\\\music\\\\Daft Punk\\\\Get Lucky (24bit-192kHz Remix)\\\\Get Lucky.flac";
const MP3 = "\\\\music\\\\Daft Punk\\\\Random Access Memories\\\\06 Get Lucky.mp3";

/** Synthetic slskd 0.26 search: no response/file ids, Windows paths, empty extension. */
const PHASE_C = {
  id: "search-phase-c",
  state: "Completed, ResponseLimitReached",
  isComplete: true,
  responses: [
    {
      username: "slot-album",
      hasFreeUploadSlot: true,
      queueLength: 0,
      uploadSpeed: 1_000_000,
      files: [
        {
          filename: ALBUM,
          size: 44 * MIB,
          length: 369,
          extension: "",
          isLocked: false,
          bitRate: 1411,
          sampleRate: 44100,
          bitDepth: 16,
        },
        {
          filename: MP3,
          size: 8 * MIB,
          length: 369,
          extension: ".mp3",
          bitRate: 320,
          isLocked: false,
        },
        {
          filename: ALBUM,
          size: 80 * MIB,
          length: 369,
          extension: "flac",
          isLocked: true,
          bitDepth: 24,
          sampleRate: 192000,
          bitRate: 9216,
        },
      ],
      lockedFiles: [
        {
          filename: "\\\\music\\\\Daft Punk\\\\Random Access Memories\\\\06 Get Lucky.flac",
          size: 44 * MIB,
          extension: "flac",
          bitDepth: 24,
          sampleRate: 192000,
          bitRate: 9216,
          isLocked: true,
        },
      ],
    },
    {
      username: "queued-hifi",
      hasFreeUploadSlot: false,
      queueLength: 4,
      uploadSpeed: 20_000_000,
      files: [
        {
          filename: ALBUM,
          size: 46 * MIB,
          length: 369,
          extension: "flac",
          bitDepth: 24,
          sampleRate: 96000,
          bitRate: 4608,
          isLocked: false,
        },
      ],
    },
    {
      username: "remix-fast",
      hasFreeUploadSlot: true,
      queueLength: 0,
      uploadSpeed: 15_000_000,
      files: [
        {
          // 48 kHz stays inside the default sample-rate cap. This file is the version-penalty case, not a hi-res exclusion.
          filename: REMIX,
          size: 40 * MIB,
          length: 420,
          extension: "flac",
          bitDepth: 24,
          sampleRate: 48000,
          bitRate: 2304,
          isLocked: false,
        },
        {
          filename: HUGE,
          size: 464 * MIB,
          length: 630,
          extension: "flac",
          bitDepth: 24,
          sampleRate: 192000,
          bitRate: 9216,
          isLocked: false,
        },
      ],
    },
    {
      username: "aaa-unknown",
      files: [
        {
          filename: ALBUM,
          size: 44 * MIB,
          length: 369,
          extension: "flac",
          bitDepth: 24,
          sampleRate: 192000,
          bitRate: 9216,
        },
      ],
    },
  ],
};

const phaseOpts = {
  allowedExtensions: AUDIO,
  maxFileSizeMb: 200,
  query: { artist: "Daft Punk", title: "Get Lucky" },
};

describe("slskd search ranking", () => {
  it("picks the club remix by default and still picks it when remix is preferred", () => {
    const first = selectSearch(PHASE_C, phaseOpts);
    const second = selectSearch(PHASE_C, phaseOpts);
    expect(first).toEqual(second);
    expect(first.outcome).toBe("selected");
    if (first.outcome !== "selected") return;
    expect(first.file).toMatchObject({ username: "remix-fast", filename: REMIX, extension: ".flac" });
    expect(first.versionClass).toBe("remix");
    expect(first.breakdown.versionPreference).toBe(1);
    expect(first.total).toBe(Object.values(first.breakdown).reduce((sum, value) => sum + value, 0));

    const balanced = selectSearch(PHASE_C, { ...phaseOpts, versionPreference: "balanced" });
    expect(balanced.outcome).toBe("selected");
    if (balanced.outcome !== "selected") return;
    expect(balanced.file).toMatchObject({ username: "remix-fast", filename: REMIX, extension: ".flac" });
    expect(balanced.breakdown.versionPreference).toBe(1);

    const remix = selectSearch(PHASE_C, { ...phaseOpts, versionPreference: "remix" });
    expect(remix.outcome).toBe("selected");
    if (remix.outcome !== "selected") return;
    expect(remix.file).toMatchObject({ username: "remix-fast", filename: REMIX, extension: ".flac", bitRate: 2304 });
    expect(remix.breakdown.versionPreference).toBeGreaterThan(0);
    expect(remix.breakdown.longRecording).toBe(0);
    expect(remix.total).toBe(Object.values(remix.breakdown).reduce((sum, value) => sum + value, 0));
  });

  it("still skips the oversize master when the request names the remix", () => {
    const asked = selectSearch(PHASE_C, {
      ...phaseOpts,
      query: { artist: "Daft Punk", title: "Get Lucky Remix" },
    });
    expect(asked.outcome).toBe("selected");
    if (asked.outcome !== "selected") return;
    expect(asked.file).toMatchObject({ username: "remix-fast", filename: REMIX, size: 40 * MIB });
    expect(asked.file.filename).not.toBe(HUGE);
    expect(asked.breakdown.requestedVersion).toBeGreaterThan(0);
  });

  it("gives the same pick for the search object, a responses wrapper, and a bare array", () => {
    const searchObject = selectSearchResult(PHASE_C, phaseOpts);
    const wrapped = selectSearchResult({ responses: PHASE_C.responses }, phaseOpts);
    const bare = selectSearchResult(PHASE_C.responses, phaseOpts);
    expect(wrapped).toEqual(searchObject);
    expect(bare).toEqual(searchObject);
  });

  it("excludes files above the configured size cap and can raise that cap", () => {
    const onlyHuge = {
      responses: [
        {
          username: "remix-fast",
          hasFreeUploadSlot: true,
          queueLength: 0,
          uploadSpeed: 1,
          files: [{ filename: HUGE, size: 464 * MIB, extension: "flac", length: 630, bitDepth: 24, sampleRate: 192000 }],
        },
      ],
    };
    // This file is 24/192. Turn the broadcast caps off so the assertion is the size cap alone.
    const sizeOnly = { allowedExtensions: AUDIO, maxSampleRate: null, maxBitDepth: null };
    expect(selectSearchResult(onlyHuge, { ...sizeOnly, maxFileSizeMb: 200 })).toBeNull();
    expect(selectSearchResult(onlyHuge, sizeOnly)).toBeNull();
    expect(selectSearchResult(onlyHuge, { ...sizeOnly, maxFileSizeMb: 500 })?.filename).toBe(HUGE);
    expect(selectSearchResult(onlyHuge, { ...sizeOnly, maxFileSizeMb: null })?.size).toBe(464 * MIB);
  });

  it("never selects lockedFiles or files with isLocked true", () => {
    const payload = {
      responses: [
        {
          username: "locker",
          hasFreeUploadSlot: true,
          queueLength: 0,
          uploadSpeed: 99_000_000,
          files: [
            {
              filename: ALBUM,
              size: 44 * MIB,
              extension: "flac",
              isLocked: true,
              bitDepth: 24,
              sampleRate: 192000,
            },
          ],
          lockedFiles: [
            {
              filename: ALBUM,
              size: 44 * MIB,
              extension: "flac",
              bitDepth: 24,
              sampleRate: 192000,
            },
          ],
        },
        {
          username: "ok-mp3",
          hasFreeUploadSlot: false,
          queueLength: 9,
          uploadSpeed: 1,
          files: [{ filename: MP3, size: 8 * MIB, extension: "mp3", bitRate: 320 }],
        },
      ],
    };
    expect(selectSearchResult(payload, phaseOpts)).toMatchObject({ username: "ok-mp3", filename: MP3 });
    expect(
      selectSearchResult(
        { responses: [payload.responses[0]] },
        phaseOpts,
      ),
    ).toBeNull();
  });

  it("applies an optional duration cap from length and keeps files that omit length", () => {
    const shortName = "\\\\music\\\\Album\\\\short.flac";
    const longName = "\\\\music\\\\Album\\\\long.flac";
    const unknownName = "\\\\music\\\\Album\\\\unknown-length.flac";
    const payload = {
      responses: [
        {
          username: "peer",
          hasFreeUploadSlot: true,
          queueLength: 0,
          uploadSpeed: 1,
          files: [
            // 48 kHz is the default cap, so this file is excluded by duration only, not by sample rate.
            { filename: longName, size: 30 * MIB, length: 630, extension: "flac", bitDepth: 24, sampleRate: 48000 },
            { filename: shortName, size: 20 * MIB, length: 200, extension: "flac", bitDepth: 16, sampleRate: 44100 },
            { filename: unknownName, size: 25 * MIB, extension: "flac", bitDepth: 16, sampleRate: 44100 },
          ],
        },
      ],
    };
    const capped = selectSearchResult(payload, { allowedExtensions: AUDIO, maxDurationSeconds: 400 });
    expect(capped?.filename).not.toBe(longName);
    const unlimited = selectSearchResult(payload, { allowedExtensions: AUDIO, maxDurationSeconds: null });
    expect(unlimited?.filename).toBe(longName);
    const onlyLong = {
      responses: [
        {
          username: "peer",
          hasFreeUploadSlot: true,
          queueLength: 0,
          uploadSpeed: 1,
          files: [{ filename: longName, size: 30 * MIB, length: 630, extension: "flac" }],
        },
      ],
    };
    const onlyUnknown = {
      responses: [
        {
          username: "peer",
          hasFreeUploadSlot: true,
          queueLength: 0,
          uploadSpeed: 1,
          files: [{ filename: unknownName, size: 25 * MIB, extension: "flac" }],
        },
      ],
    };
    expect(selectSearchResult(onlyLong, { allowedExtensions: AUDIO, maxDurationSeconds: 400 })).toBeNull();
    expect(selectSearchResult(onlyUnknown, { allowedExtensions: AUDIO, maxDurationSeconds: 400 })?.filename).toBe(unknownName);
    expect(
      selectSearchResult(
        { responses: [{ username: "peer", files: [{ filename: longName, length: 630, extension: "flac" }] }] },
        phaseOpts,
      ),
    ).toBeNull();
  });

  it("lets format preference beat peer availability without dropping the other format", () => {
    const payload = {
      responses: [
        {
          username: "aaa-mp3",
          hasFreeUploadSlot: true,
          queueLength: 0,
          uploadSpeed: 50_000_000,
          files: [{ filename: "\\\\music\\\\track.mp3", size: 8 * MIB, extension: "mp3", bitRate: 320 }],
        },
        {
          username: "zzz-flac",
          hasFreeUploadSlot: false,
          queueLength: 20,
          uploadSpeed: 1,
          files: [{ filename: "\\\\music\\\\track.flac", size: 20 * MIB, extension: "flac", bitDepth: 16, sampleRate: 44100 }],
        },
      ],
    };
    expect(selectSearchResult(payload, { allowedExtensions: AUDIO, formatPreference: "prefer_mp3" })?.username).toBe("aaa-mp3");
    expect(selectSearchResult(payload, { allowedExtensions: AUDIO, formatPreference: "prefer_flac" })?.username).toBe("zzz-flac");
    expect(selectSearchResult(payload, { allowedExtensions: AUDIO, formatPreference: "auto" })?.username).toBe("aaa-mp3");
  });

  it("prefers a free slot, then a shorter queue, then a faster upload, and penalizes an extreme queue", () => {
    const file = (filename: string) => ({
      filename,
      size: 20 * MIB,
      extension: "flac",
      bitDepth: 16,
      sampleRate: 44100,
      bitRate: 1411,
      length: 200,
    });
    const queued = selectSearchResult(
      {
        responses: [
          {
            username: "aaa-busy",
            hasFreeUploadSlot: true,
            queueLength: 8,
            uploadSpeed: 1,
            files: [file("\\\\music\\\\busy.flac")],
          },
          {
            username: "zzz-free",
            hasFreeUploadSlot: true,
            queueLength: 0,
            uploadSpeed: 1,
            files: [file("\\\\music\\\\free.flac")],
          },
        ],
      },
      { allowedExtensions: AUDIO },
    );
    expect(queued?.username).toBe("zzz-free");

    const faster = selectSearchResult(
      {
        responses: [
          {
            username: "aaa-slow",
            hasFreeUploadSlot: true,
            queueLength: 0,
            uploadSpeed: 100,
            files: [file("\\\\music\\\\slow.flac")],
          },
          {
            username: "zzz-fast",
            hasFreeUploadSlot: true,
            queueLength: 0,
            uploadSpeed: 5_000_000,
            files: [file("\\\\music\\\\fast.flac")],
          },
        ],
      },
      { allowedExtensions: AUDIO },
    );
    expect(faster?.username).toBe("zzz-fast");

    const missing = selectSearchResult(
      {
        responses: [
          {
            username: "aaa-unknown",
            // 24/48 scores the same quality as 16/44.1. The busy peer is penalized, so the unknown peer wins. 192 kHz is dropped before scoring.
            files: [{ filename: "\\\\music\\\\unknown.flac", size: 20 * MIB, extension: "flac", bitDepth: 24, sampleRate: 48000 }],
          },
          {
            username: "zzz-known-busy",
            hasFreeUploadSlot: false,
            queueLength: 3,
            uploadSpeed: 1,
            files: [file("\\\\music\\\\known.flac")],
          },
        ],
      },
      { allowedExtensions: AUDIO },
    );
    expect(missing?.username).toBe("aaa-unknown");

    const extreme = selectSearchResult(
      {
        responses: [
          {
            username: "aaa-extreme",
            hasFreeUploadSlot: true,
            queueLength: 5000,
            uploadSpeed: 50_000_000,
            files: [{ filename: "\\\\music\\\\extreme.flac", size: 20 * MIB, extension: "flac", bitDepth: 24, sampleRate: 48000, length: 200 }],
          },
          {
            username: "zzz-short",
            hasFreeUploadSlot: true,
            queueLength: 0,
            uploadSpeed: 1,
            files: [file("\\\\music\\\\short-queue.flac")],
          },
        ],
      },
      { allowedExtensions: AUDIO },
    );
    expect(extreme?.username).toBe("zzz-short");
  });

  it("rejects files over the hard size cap and does not rank the survivors by size", () => {
    const peer = (username: string, filename: string, size: number) => ({
      username,
      hasFreeUploadSlot: true,
      queueLength: 0,
      uploadSpeed: 1000,
      files: [{ filename, size, extension: "flac", bitDepth: 16, sampleRate: 44100, bitRate: 1000, length: 200 }],
    });
    const pick = selectSearchResult(
      {
        responses: [
          peer("aaa-large", "\\\\album\\\\large.flac", 70 * MIB),
          peer("mmm-small", "\\\\album\\\\small.flac", 10 * MIB),
          peer("zzz-typical", "\\\\album\\\\typical.flac", 40 * MIB),
        ],
      },
      { allowedExtensions: AUDIO, maxFileSizeMb: 200 },
    );
    expect(pick).toMatchObject({ username: "aaa-large", size: 70 * MIB });
    expect(
      selectSearchResult(
        {
          responses: [
            peer("aaa-large", "\\\\album\\\\large.flac", 70 * MIB),
            peer("mmm-small", "\\\\album\\\\small.flac", 10 * MIB),
            peer("zzz-typical", "\\\\album\\\\typical.flac", 40 * MIB),
          ],
        },
        { allowedExtensions: AUDIO },
      ),
    ).toMatchObject({ username: "mmm-small", size: 10 * MIB });
  });

  it("drops files above the hard size cap before scoring the rest", () => {
    const peer = (username: string, filename: string, size: number) => ({
      username,
      hasFreeUploadSlot: true,
      queueLength: 0,
      uploadSpeed: 1000,
      files: [{ filename, size, extension: "flac", bitDepth: 16, sampleRate: 44100, bitRate: 1000 }],
    });
    const pick = selectSearchResult(
      {
        responses: [
          peer("zzz-typical", "\\\\album\\\\typical.flac", 40 * MIB),
          peer("aaa-near", "\\\\album\\\\near.flac", 50 * MIB),
          peer("mmm-small", "\\\\album\\\\small.flac", 10 * MIB),
          peer("huge-peer", "\\\\album\\\\huge.flac", 400 * MIB),
        ],
      },
      { allowedExtensions: AUDIO, maxFileSizeMb: 200 },
    );
    expect(pick).toMatchObject({ username: "aaa-near", size: 50 * MIB });
    const dropped = selectSearch(
      {
        responses: [
          peer("zzz-typical", "\\\\album\\\\typical.flac", 40 * MIB),
          peer("aaa-near", "\\\\album\\\\near.flac", 50 * MIB),
          peer("mmm-small", "\\\\album\\\\small.flac", 10 * MIB),
          peer("huge-peer", "\\\\album\\\\huge.flac", 400 * MIB),
        ],
      },
      { allowedExtensions: AUDIO, maxFileSizeMb: 200 },
    );
    expect(dropped.outcome).toBe("selected");
    if (dropped.outcome === "selected") expect(dropped.removed.max_file_size).toBe(1);
  });

  it("gives a normal-length remix the extended bonus unless the request is what made the word match", () => {
    const clean = {
      username: "clean-peer",
      hasFreeUploadSlot: false,
      queueLength: 6,
      uploadSpeed: 1,
      files: [{ filename: "\\\\music\\\\Album\\\\Song.flac", size: 30 * MIB, extension: "flac", bitDepth: 16, sampleRate: 44100 }],
    };
    const remix = {
      username: "remix-peer",
      hasFreeUploadSlot: true,
      queueLength: 0,
      uploadSpeed: 9_000_000,
      files: [
        {
          filename: "\\\\music\\\\Get Lucky (Remix)\\\\Song (Club Remix).flac",
          size: 28 * MIB,
          extension: "flac",
          // Inside the default caps, so a waived penalty can still select this file.
          bitDepth: 24,
          sampleRate: 48000,
        },
      ],
    };
    const base = { allowedExtensions: AUDIO, maxFileSizeMb: 200 };
    expect(selectSearchResult({ responses: [remix, clean] }, { ...base, query: { artist: "A", title: "Song" } })?.username).toBe(
      "remix-peer",
    );
    expect(
      selectSearchResult(
        {
          responses: [
            {
              ...remix,
              files: [
                {
                  ...remix.files[0]!,
                  filename: "\\\\music\\\\Get Lucky (Remix)\\\\Song Remixed (Club Remix).flac",
                },
              ],
            },
            {
              ...clean,
              files: [{ ...clean.files[0]!, filename: "\\\\music\\\\Album\\\\Song Remixed.flac" }],
            },
          ],
        },
        { ...base, query: { title: "Song Remixed" } },
      )?.username,
    ).toBe("remix-peer");
    expect(
      selectSearchResult({ responses: [remix, clean] }, { ...base, context: { artist: "A", title: "Song Remix" } })?.username,
    ).toBe("remix-peer");
    expect(
      selectSearchResult(
        {
          responses: [
            {
              username: "editorial",
              hasFreeUploadSlot: true,
              queueLength: 0,
              uploadSpeed: 1,
              files: [{ filename: "\\\\music\\\\editorial.flac", size: 20 * MIB, extension: "flac" }],
            },
          ],
        },
        base,
      )?.username,
    ).toBe("editorial");
    // "Remixes" is not the word "remix", so the folder is not penalized.
    expect(
      selectSearchResult(
        {
          responses: [
            {
              username: "remixes-folder",
              hasFreeUploadSlot: true,
              queueLength: 0,
              uploadSpeed: 5,
              files: [{ filename: "\\\\music\\\\Remixes\\\\Song.flac", size: 20 * MIB, extension: "flac", bitDepth: 24 }],
            },
            {
              username: "studio",
              hasFreeUploadSlot: false,
              queueLength: 1,
              uploadSpeed: 1,
              files: [{ filename: "\\\\music\\\\Album\\\\Song.flac", size: 20 * MIB, extension: "flac", bitDepth: 16 }],
            },
          ],
        },
        { ...base, query: { title: "Song" } },
      )?.username,
    ).toBe("remixes-folder");
  });

  it("excludes 24/192 by default, selects 16/44.1, and still counts files that omit sample rate and bit depth", () => {
    const cd = "\\\\music\\\\Album\\\\06 Get Lucky.flac";
    const hires = "\\\\music\\\\Album\\\\06 Get Lucky (24-192).flac";
    const bare = "\\\\music\\\\Album\\\\06 Get Lucky (untagged).flac";
    const peer = (username: string, filename: string, extra: Record<string, unknown>) => ({
      username,
      hasFreeUploadSlot: true,
      queueLength: 0,
      uploadSpeed: 1000,
      files: [{ filename, size: 40 * MIB, extension: "flac", length: 248, ...extra }],
    });
    const hiresFile = { bitDepth: 24, sampleRate: 192000, bitRate: 9216 };
    const cdFile = { bitDepth: 16, sampleRate: 44100, bitRate: 1411 };
    const payload = {
      responses: [
        peer("aaa-hires", hires, hiresFile),
        peer("zzz-bare", bare, {}),
        peer("mmm-cd", cd, cdFile),
      ],
    };
    const opts = { allowedExtensions: AUDIO, maxFileSizeMb: 200 };
    expect(selectSearchResult(payload, opts)).toMatchObject({ username: "mmm-cd", filename: cd, size: 40 * MIB });
    expect(selectSearchResult({ responses: [payload.responses[0]!] }, opts)).toBeNull();
    expect(selectSearchResult({ responses: [payload.responses[0]!, payload.responses[1]!] }, opts)).toMatchObject({
      username: "zzz-bare",
      filename: bare,
    });
    // Lossless files are equally acceptable, tagged or not. The earlier username wins.
    expect(
      selectSearchResult(
        {
          responses: [peer("zzz-cd", cd, cdFile), peer("aaa-bare", bare, { bitRate: 1411 })],
        },
        opts,
      )?.username,
    ).toBe("aaa-bare");
    // 24/48 is inside the cap and scores the same quality as 16/44.1. The earlier username wins the tie. 192 kHz does not, unless the cap is raised.
    expect(
      selectSearchResult(
        {
          responses: [
            peer("cd", cd, cdFile),
            peer("broadcast", "\\\\music\\\\Album\\\\broadcast.flac", { bitDepth: 24, sampleRate: 48000, bitRate: 2304 }),
          ],
        },
        opts,
      )?.username,
    ).toBe("broadcast");
    expect(
      selectSearchResult(
        { responses: [peer("deep", "\\\\music\\\\Album\\\\32bit.flac", { bitDepth: 32, sampleRate: 44100 })] },
        opts,
      ),
    ).toBeNull();
    expect(selectSearchResult(payload, { ...opts, maxSampleRate: 192000 })?.username).toBe("aaa-hires");
    expect(selectSearchResult(payload, { ...opts, maxSampleRate: null, maxBitDepth: null })?.username).toBe("aaa-hires");
  });

  it("returns no pick and does not relax filters when every candidate is removed", () => {
    const album = "\\\\music\\\\Album\\\\06 Get Lucky.flac";
    const payload = {
      responses: [
        {
          username: "peer",
          hasFreeUploadSlot: true,
          queueLength: 0,
          uploadSpeed: 5_000_000,
          files: [
            { filename: "\\\\music\\\\notes.txt", size: 10 * MIB, extension: "txt" },
            { filename: "\\\\music\\\\huge.flac", size: 400 * MIB, extension: "flac", bitDepth: 16, sampleRate: 44100, length: 200 },
            { filename: "\\\\music\\\\long.flac", size: 30 * MIB, extension: "flac", bitDepth: 16, sampleRate: 44100, length: 900 },
            { filename: "\\\\music\\\\hires.flac", size: 40 * MIB, extension: "flac", bitDepth: 24, sampleRate: 192000, length: 200 },
            { filename: "\\\\music\\\\deep.flac", size: 40 * MIB, extension: "flac", bitDepth: 32, sampleRate: 44100, length: 200 },
            {
              filename: "\\\\music\\\\locked.flac",
              size: 40 * MIB,
              extension: "flac",
              bitDepth: 16,
              sampleRate: 44100,
              length: 200,
              isLocked: true,
            },
          ],
          lockedFiles: [
            { filename: album, size: 44 * MIB, extension: "flac", bitDepth: 16, sampleRate: 44100, length: 248 },
          ],
        },
      ],
    };
    const opts = { allowedExtensions: AUDIO, maxFileSizeMb: 200, maxDurationSeconds: 400 };
    const removed = {
      locked: 2,
      junk: 0,
      extensions: 1,
      format_preference: 0,
      min_file_size: 0,
      max_file_size: 1,
      max_duration: 1,
      max_sample_rate: 1,
      max_bit_depth: 1,
      title_mismatch: 0,
      medley: 0,
      tribute_or_cover: 0,
      artist_mismatch: 0,
      stem: 0,
      long_recording: 0,
      under_bitrate: 0,
      short_recording: 0,
    };
    expect(selectSearch(payload, opts)).toEqual({
      outcome: "no_suitable_result",
      removed,
      reason:
        "no_suitable_result: locked=2, junk=0, extensions=1, format_preference=0, min_file_size=0, max_file_size=1, max_duration=1, max_sample_rate=1, max_bit_depth=1, title_mismatch=0, medley=0, tribute_or_cover=0, artist_mismatch=0, stem=0, long_recording=0, under_bitrate=0, short_recording=0",
    });
    expect(selectSearchResult(payload, opts)).toBeNull();
    expect(selectSearch({ responses: [] }, opts)).toEqual({ outcome: "no_responses" });
    expect(selectSearchResult({ isComplete: true, responses: [] }, opts)).toBeNull();
    // The oversize album is eligible only when the caller raises the cap. The selector does not do that itself.
    expect(selectSearchResult(payload, { ...opts, maxFileSizeMb: 500 })?.filename).toBe("\\\\music\\\\huge.flac");
  });

  it("still selects a penalized file when nothing else is eligible", () => {
    const only = selectSearchResult(
      {
        responses: [
          {
            username: "remix-peer",
            hasFreeUploadSlot: true,
            queueLength: 0,
            uploadSpeed: 1,
            files: [{ filename: REMIX, size: 40 * MIB, extension: "flac" }],
          },
        ],
      },
      phaseOpts,
    );
    expect(only?.filename).toBe(REMIX);
  });

  it("ranks a requested remix above the album cut even when the album peer is better", () => {
    const album = {
      username: "album-peer",
      hasFreeUploadSlot: true,
      queueLength: 0,
      uploadSpeed: 9_000_000,
      files: [
        {
          filename: "\\\\music\\\\Album\\\\Get Lucky.flac",
          size: 40 * MIB,
          extension: "flac",
          bitDepth: 16,
          sampleRate: 44100,
        },
      ],
    };
    const remix = {
      username: "remix-peer",
      hasFreeUploadSlot: false,
      queueLength: 8,
      uploadSpeed: 1,
      files: [
        {
          filename: "\\\\music\\\\Remix\\\\Get Lucky (Remix).flac",
          size: 28 * MIB,
          extension: "flac",
          bitDepth: 16,
          sampleRate: 44100,
        },
      ],
    };
    const pick = selectSearchResult(
      { responses: [album, remix] },
      { allowedExtensions: AUDIO, query: { artist: "Daft Punk", title: "Get Lucky Remix" } },
    );
    expect(pick?.username).toBe("remix-peer");
  });

  it("prefers a free upload slot over an artist name that is only in the path", () => {
    const named = {
      username: "queued",
      hasFreeUploadSlot: false,
      queueLength: 6,
      uploadSpeed: 1,
      files: [
        {
          filename: "\\\\music\\\\Daft Punk\\\\Album\\\\Get Lucky.flac",
          size: 20 * MIB,
          extension: "flac",
          bitDepth: 16,
          sampleRate: 44100,
        },
      ],
    };
    const anon = {
      username: "free",
      hasFreeUploadSlot: true,
      queueLength: 0,
      uploadSpeed: 9_000_000,
      files: [
        {
          filename: "\\\\music\\\\Album\\\\Get Lucky.flac",
          size: 20 * MIB,
          extension: "flac",
          bitDepth: 16,
          sampleRate: 44100,
        },
      ],
    };
    expect(
      selectSearchResult(
        { responses: [anon, named] },
        { allowedExtensions: AUDIO, query: { artist: "Daft Punk", title: "Get Lucky" } },
      )?.username,
    ).toBe("free");
  });

  it("excludes __MACOSX and ._ files and files under the minimum size", () => {
    const real = "music/Album/Get Lucky.mp3";
    const payload = {
      responses: [
        {
          username: "peer",
          files: [
            { filename: "music/__MACOSX/._Get Lucky.mp3", size: 300, extension: "mp3" },
            { filename: "music\\__macosx\\Get Lucky.mp3", size: 8 * MIB, extension: "mp3" },
            { filename: "music/Album/._Get Lucky.mp3", size: 8 * MIB, extension: "mp3" },
            { filename: "music/Album/Get Lucky.mp3", size: 300, extension: "mp3" },
            { filename: real, size: 8 * MIB, extension: "mp3" },
          ],
        },
      ],
    };
    const opts = { allowedExtensions: [".mp3"], query: { title: "Get Lucky" } };
    expect(selectSearchResult(payload, opts)?.filename).toBe(real);
    expect(
      selectSearchResult(
        {
          responses: [
            {
              username: "not-a-segment",
              files: [{ filename: "music/Album/my__macosx Get Lucky.mp3", size: 8 * MIB, extension: "mp3" }],
            },
          ],
        },
        opts,
      )?.username,
    ).toBe("not-a-segment");
    const blocked = selectSearch(
      {
        responses: [
          {
            username: "peer",
            files: [
              { filename: "music/__MACOSX/._Get Lucky.mp3", size: 300, extension: "mp3" },
              { filename: "music\\__MACOSX\\._Get Lucky.mp3", size: 180, extension: "mp3" },
              { filename: "music/Album/._Hidden.mp3", size: 8 * MIB, extension: "mp3" },
              { filename: "music/Album/Get Lucky.mp3", size: 300, extension: "mp3" },
            ],
          },
        ],
      },
      opts,
    );
    expect(blocked).toMatchObject({
      outcome: "no_suitable_result",
      removed: { junk: 3, min_file_size: 1, title_mismatch: 0 },
    });
    expect(
      selectSearchResult(
        {
          responses: [
            {
              username: "tiny",
              files: [{ filename: "music/Get Lucky.mp3", size: 300, extension: "mp3" }],
            },
          ],
        },
        { ...opts, minFileSizeMb: null },
      )?.size,
    ).toBe(300);
  });

  it("rejects a game stem under an ogg-only config when the title does not match", () => {
    const drums = "\\\\games\\\\Rock Band 4 DLC\\\\drums.ogg";
    const song = "\\\\music\\\\Daft Punk\\\\Get Lucky.ogg";
    const drumsOnly = {
      responses: [
        {
          username: "game",
          hasFreeUploadSlot: true,
          queueLength: 0,
          uploadSpeed: 9_000_000,
          files: [{ filename: drums, size: 4 * MIB, extension: "ogg" }],
        },
      ],
    };
    const opts = { allowedExtensions: [".ogg"], query: { artist: "Daft Punk", title: "Get Lucky" } };
    expect(selectSearch(drumsOnly, opts)).toEqual({
      outcome: "no_suitable_result",
      removed: {
        locked: 0,
        junk: 0,
        extensions: 0,
        format_preference: 0,
        min_file_size: 0,
        max_file_size: 0,
        max_duration: 0,
        max_sample_rate: 0,
        max_bit_depth: 0,
        title_mismatch: 1,
        medley: 0,
        tribute_or_cover: 0,
        artist_mismatch: 0,
        stem: 0,
        long_recording: 0,
        under_bitrate: 0,
        short_recording: 0,
      },
      reason:
        "no_suitable_result: locked=0, junk=0, extensions=0, format_preference=0, min_file_size=0, max_file_size=0, max_duration=0, max_sample_rate=0, max_bit_depth=0, title_mismatch=1, medley=0, tribute_or_cover=0, artist_mismatch=0, stem=0, long_recording=0, under_bitrate=0, short_recording=0",
    });
    expect(selectSearchResult(drumsOnly, { allowedExtensions: [".ogg"] })).toBeNull();
    expect(
      selectSearchResult(
        {
          responses: [
            drumsOnly.responses[0]!,
            {
              username: "album",
              hasFreeUploadSlot: false,
              queueLength: 4,
              uploadSpeed: 1,
              files: [{ filename: song, size: 6 * MIB, extension: "ogg" }],
            },
          ],
        },
        opts,
      ),
    ).toMatchObject({ username: "album", filename: song });
  });

  it("rejects an instrument-part basename unless the request asked for that part", () => {
    const folder = "\\\\music\\\\Daft Punk ft. Pharrell Williams - Get Lucky\\\\";
    const drums = `${folder}drums.ogg`;
    const track = `${folder}get lucky.ogg`;
    const opts = {
      allowedExtensions: [".ogg"],
      minFileSizeMb: null as null,
      query: { artist: "Daft Punk", title: "Get Lucky" },
    };
    expect(
      selectSearchResult(
        {
          responses: [
            {
              username: "peer",
              files: [
                { filename: drums, size: 8 * MIB, extension: "ogg" },
                { filename: track, size: 8 * MIB, extension: "ogg" },
              ],
            },
          ],
        },
        opts,
      )?.filename,
    ).toBe(track);
    expect(selectSearchResult({ responses: [{ username: "peer", files: [{ filename: drums, size: 8 * MIB, extension: "ogg" }] }] }, opts)).toBeNull();
    const parts = "\\\\music\\\\parts\\\\";
    expect(
      selectSearchResult(
        {
          responses: [
            {
              username: "peer",
              files: [
                { filename: `${parts}bass.ogg`, size: 8 * MIB, extension: "ogg" },
                { filename: `${parts}drums.ogg`, size: 8 * MIB, extension: "ogg" },
              ],
            },
          ],
        },
        { allowedExtensions: [".ogg"], minFileSizeMb: null, query: { title: "drums" } },
      )?.filename,
    ).toBe(`${parts}drums.ogg`);
    expect(
      selectSearchResult(
        {
          responses: [
            {
              username: "peer",
              files: [{ filename: "\\\\stems\\\\drums\\\\drums.ogg", size: 8 * MIB, extension: "ogg" }],
            },
          ],
        },
        { allowedExtensions: [".ogg"], minFileSizeMb: null, query: { title: "drums" } },
      ),
    ).toBeNull();
  });

  it("ranks a remix above an instrument part even when the drums peer has the better queue", () => {
    const folder = "\\\\music\\\\Daft Punk - Get Lucky\\\\";
    const remix = `${folder}01 - Get Lucky - Daft Punk Remix.ogg`;
    const drums = `${folder}drums.ogg`;
    const both = `${folder}drums remix.ogg`;
    const opts = {
      allowedExtensions: [".ogg"],
      minFileSizeMb: null as null,
      query: { artist: "Daft Punk", title: "Get Lucky" },
    };
    expect(
      selectSearchResult(
        {
          responses: [
            {
              username: "drums-peer",
              hasFreeUploadSlot: true,
              queueLength: 0,
              uploadSpeed: 100,
              files: [{ filename: drums, size: 8 * MIB, extension: "ogg" }],
            },
            {
              username: "remix-peer",
              hasFreeUploadSlot: false,
              queueLength: 9,
              uploadSpeed: 1,
              files: [{ filename: remix, size: 8 * MIB, extension: "ogg" }],
            },
          ],
        },
        opts,
      )?.filename,
    ).toBe(remix);
    expect(
      selectSearchResult(
        {
          responses: [
            {
              username: "both",
              hasFreeUploadSlot: true,
              queueLength: 0,
              files: [{ filename: both, size: 8 * MIB, extension: "ogg" }],
            },
            {
              username: "remix-peer",
              hasFreeUploadSlot: false,
              queueLength: 4,
              files: [{ filename: remix, size: 8 * MIB, extension: "ogg" }],
            },
          ],
        },
        opts,
      )?.filename,
    ).toBe(remix);
  });

  it("matches a title with diacritics and ignores a bracketed feat credit", () => {
    const song = "music/Cafe del Mar.flac";
    const credit = "music/Someone Else.flac";
    const pick = selectSearchResult(
      {
        responses: [
          {
            username: "credit",
            hasFreeUploadSlot: true,
            queueLength: 0,
            uploadSpeed: 9,
            files: [{ filename: credit, size: 12 * MIB, extension: "flac" }],
          },
          {
            username: "song",
            hasFreeUploadSlot: false,
            queueLength: 3,
            uploadSpeed: 1,
            files: [{ filename: song, size: 10 * MIB, extension: "flac" }],
          },
        ],
      },
      { allowedExtensions: AUDIO, query: { artist: "Energy 52", title: "Café del Mar (feat. Someone Else)" } },
    );
    expect(pick).toMatchObject({ username: "song", filename: song });
    expect(
      selectSearchResult(
        {
          responses: [
            {
              username: "accent",
              files: [{ filename: "music/Café del Mar.flac", size: 10 * MIB, extension: "flac" }],
            },
          ],
        },
        { allowedExtensions: AUDIO, query: { title: "Cafe del Mar" } },
      )?.username,
    ).toBe("accent");
  });

  it("counts junk, min size, and title mismatch in no_suitable_result", () => {
    const payload = {
      responses: [
        {
          username: "peer",
          files: [
            {
              filename: "\\\\music\\\\Get Lucky.flac",
              size: 40 * MIB,
              extension: "flac",
              bitDepth: 16,
              sampleRate: 44100,
              length: 200,
              isLocked: true,
            },
            { filename: "music/__MACOSX/._Get Lucky.mp3", size: 8 * MIB, extension: "mp3" },
            { filename: "\\\\music\\\\notes.txt", size: 10 * MIB, extension: "txt" },
            { filename: "\\\\music\\\\Get Lucky.flac", size: 300, extension: "flac", bitDepth: 16, sampleRate: 44100 },
            {
              filename: "\\\\music\\\\Get Lucky.flac",
              size: 400 * MIB,
              extension: "flac",
              bitDepth: 16,
              sampleRate: 44100,
              length: 200,
            },
            {
              filename: "\\\\music\\\\Get Lucky.flac",
              size: 30 * MIB,
              extension: "flac",
              bitDepth: 16,
              sampleRate: 44100,
              length: 900,
            },
            {
              filename: "\\\\music\\\\Get Lucky.flac",
              size: 40 * MIB,
              extension: "flac",
              bitDepth: 24,
              sampleRate: 192000,
              length: 200,
            },
            {
              filename: "\\\\music\\\\Get Lucky.flac",
              size: 40 * MIB,
              extension: "flac",
              bitDepth: 32,
              sampleRate: 44100,
              length: 200,
            },
            { filename: "\\\\games\\\\Rock Band 4 DLC\\\\drums.ogg", size: 5 * MIB, extension: "ogg" },
          ],
        },
      ],
    };
    const removed = {
      locked: 1,
      junk: 1,
      extensions: 1,
      format_preference: 0,
      min_file_size: 1,
      max_file_size: 1,
      max_duration: 1,
      max_sample_rate: 1,
      max_bit_depth: 1,
      title_mismatch: 1,
      medley: 0,
      tribute_or_cover: 0,
      artist_mismatch: 0,
      stem: 0,
      long_recording: 0,
      under_bitrate: 0,
      short_recording: 0,
    };
    expect(
      selectSearch(payload, {
        allowedExtensions: AUDIO,
        maxFileSizeMb: 200,
        maxDurationSeconds: 400,
        query: { artist: "Daft Punk", title: "Get Lucky" },
      }),
    ).toEqual({
      outcome: "no_suitable_result",
      removed,
      reason: `no_suitable_result: locked=1, junk=1, extensions=1, format_preference=0, min_file_size=1, max_file_size=1, max_duration=1, max_sample_rate=1, max_bit_depth=1, title_mismatch=1, medley=0, tribute_or_cover=0, artist_mismatch=0, stem=0, long_recording=0, under_bitrate=0, short_recording=0`,
    });
  });

  it("penalizes stem, stems, multitrack, and cappella spellings by default", () => {
    const clean = {
      username: "album",
      hasFreeUploadSlot: false,
      queueLength: 4,
      uploadSpeed: 1,
      files: [{ filename: "\\\\music\\\\Album\\\\Song.flac", size: 20 * MIB, extension: "flac" }],
    };
    function against(filename: string) {
      return selectSearchResult(
        {
          responses: [
            {
              username: "other",
              hasFreeUploadSlot: true,
              queueLength: 0,
              uploadSpeed: 9_000_000,
              files: [{ filename, size: 20 * MIB, extension: "flac" }],
            },
            clean,
          ],
        },
        { allowedExtensions: AUDIO, query: { title: "Song" } },
      )?.username;
    }
    expect(against("\\\\music\\\\Stems\\\\Song.flac")).toBe("album");
    expect(against("\\\\music\\\\Stem\\\\Song.flac")).toBe("album");
    expect(against("\\\\music\\\\Multitrack\\\\Song.flac")).toBe("album");
    expect(against("\\\\music\\\\A Cappella\\\\Song.flac")).toBe("album");
    expect(against("\\\\music\\\\Album\\\\Song (Acappella).flac")).toBe("album");
    expect(against("\\\\music\\\\System\\\\Song.flac")).toBe("other");
  });
});

describe("slskd score adapter", () => {
  const opts = { allowedExtensions: [".flac", ".mp3", ".m4a", ".ogg", ".wav", ".opus"], query: { artist: "Daft Punk", title: "Get Lucky" } };

  function response(username: string, file: Record<string, unknown>) {
    return { username, hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1_600_000, files: [file] };
  }

  it("picks the same file with a stable breakdown for inline, wrapped, and bare-array payloads", () => {
    const responses = [
      response("peer-b", {
        filename: "@@abcde\\Daft Punk\\Album\\Get Lucky.mp3",
        size: 10 * MIB,
        length: 369,
        extension: "",
        bitRate: 320,
        isVariableBitRate: true,
      }),
      response("peer-a", {
        filename: "@@abcde\\Daft Punk\\Album\\06 Get Lucky.flac",
        size: 42 * MIB,
        length: 369,
        extension: "",
        sampleRate: 44100,
        bitDepth: 16,
      }),
    ];
    const inline = selectSearch({ id: "search", state: "Completed", responses }, opts);
    const wrapped = selectSearch({ responses }, opts);
    const bare = selectSearch(responses, opts);
    expect(inline.outcome).toBe("selected");
    expect(wrapped).toEqual(inline);
    expect(bare).toEqual(inline);
    if (inline.outcome !== "selected") return;
    expect(inline.file.username).toBe("peer-b");
    expect(inline.breakdown.versionPreference).toBe(0);
    expect(inline.breakdown.format).toBeGreaterThan(0);
    expect(inline.signals.quality).toBe("reported");
    expect(inline.total).toBe(Object.values(inline.breakdown).reduce((sum, value) => sum + value, 0));
  });

  it("treats a junk bitrate as unknown and falls back from a junk extension to the filename", () => {
    const junkRate = selectSearch(
      {
        responses: [
          response("junk", {
            filename: "@@abcde\\Album\\Get Lucky.mp3",
            size: 8 * MIB,
            extension: "mp3",
            bitRate: 8,
          }),
        ],
      },
      opts,
    );
    const missingRate = selectSearch(
      {
        responses: [
          response("missing", {
            filename: "@@abcde\\Album\\Get Lucky.mp3",
            size: 8 * MIB,
            extension: "mp3",
          }),
        ],
      },
      opts,
    );
    const outrageous = selectSearch(
      {
        responses: [
          response("outrageous", {
            filename: "@@abcde\\Album\\Get Lucky.mp3",
            size: 8 * MIB,
            extension: ".mp3",
            bitRate: 2991,
          }),
          response("real", {
            filename: "@@abcde\\Album\\Get Lucky.mp3",
            size: 10 * MIB,
            length: 369,
            extension: "mp3",
            bitRate: 320,
          }),
        ],
      },
      opts,
    );
    expect(junkRate.outcome).toBe("no_suitable_result");
    if (junkRate.outcome === "no_suitable_result") expect(junkRate.removed.under_bitrate).toBe(1);
    expect(missingRate.outcome).toBe("selected");
    if (missingRate.outcome !== "selected" || outrageous.outcome !== "selected") return;
    expect(missingRate.signals).toEqual({ quality: "unknown" });
    expect(missingRate.breakdown.quality).toBe(0);
    expect(outrageous.file.username).toBe("real");
    expect(outrageous.signals.quality).toBe("reported");

    const junkExt = selectSearch(
      {
        responses: [
          response("ext", {
            filename: "@@abcde\\Album\\Get Lucky.flac",
            size: 42 * MIB,
            length: 369,
            extension: "flac@synoeastream",
            sampleRate: 44100,
            bitDepth: 16,
          }),
        ],
      },
      { ...opts, maxFileSizeMb: 50 },
    );
    expect(junkExt.outcome).toBe("selected");
    if (junkExt.outcome !== "selected") return;
    expect(junkExt.file.extension).toBe(".flac");
    expect(junkExt.pick.format).toEqual({ ext: ".flac", lossless: true });
    expect(junkExt.signals.quality).toBe("reported");
  });

  it("scores an opus file that has no length", () => {
    const decision = selectSearch(
      {
        responses: [
          response("opus", {
            filename: "@@abcde\\Daft Punk\\Album\\Get Lucky.opus",
            size: 6 * MIB,
            extension: "",
          }),
        ],
      },
      opts,
    );
    expect(decision.outcome).toBe("selected");
    if (decision.outcome !== "selected") return;
    expect(decision.file.extension).toBe(".opus");
    expect(decision.pick.durationSeconds).toBeUndefined();
    expect(decision.signals.quality).toBe("unknown");
    expect(decision.breakdown.quality).toBe(0);
    expect(Number.isFinite(decision.total)).toBe(true);
  });

  it("uses a derived bitrate only when size and length exist and no reported quality does", () => {
    const junk = selectSearch(
      {
        responses: [
          response("junk-with-length", {
            filename: "@@abcde\\Album\\Get Lucky.mp3",
            size: 10 * MIB,
            length: 369,
            extension: "mp3",
            bitRate: 8,
          }),
        ],
      },
      opts,
    );
    expect(junk.outcome).toBe("no_suitable_result");
    if (junk.outcome === "no_suitable_result") expect(junk.removed.under_bitrate).toBe(1);

    const decision = selectSearch(
      {
        responses: [
          response("derived", {
            filename: "@@abcde\\Album\\Get Lucky.mp3",
            size: 10 * MIB,
            length: 369,
            extension: "mp3",
          }),
        ],
      },
      opts,
    );
    expect(decision.outcome).toBe("selected");
    if (decision.outcome !== "selected") return;
    expect(decision.signals.quality).toBe("derived");
    expect(decision.signals.derivedBitrateKbps).toBeGreaterThan(32);
    expect(decision.signals.derivedBitrateKbps).toBeLessThanOrEqual(320);
    expect(decision.breakdown.quality).toBe(1);
  });
});
