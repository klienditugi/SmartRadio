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
  it("picks the typical album FLAC from a free-slot peer", () => {
    const first = selectSearchResult(PHASE_C, phaseOpts);
    const second = selectSearchResult(PHASE_C, phaseOpts);
    expect(first).toEqual(second);
    expect(first).toEqual({
      username: "slot-album",
      filename: ALBUM,
      size: 44 * MIB,
      extension: ".flac",
      bitRate: 1411,
    });
    expect(first?.responseId).toBeUndefined();
    expect(first?.fileId).toBeUndefined();
  });

  it("lets the remix win only when the request names that version, and still skips the oversize master", () => {
    const asked = selectSearchResult(PHASE_C, {
      ...phaseOpts,
      query: { artist: "Daft Punk", title: "Get Lucky Remix" },
    });
    expect(asked).toMatchObject({ username: "remix-fast", filename: REMIX, size: 40 * MIB });
    expect(asked?.filename).not.toBe(HUGE);
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

  it("ranks extension ahead of peer availability", () => {
    const pick = selectSearchResult(
      {
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
      },
      { allowedExtensions: AUDIO },
    );
    expect(pick?.username).toBe("zzz-flac");
  });

  it("ranks a free slot, then a shorter queue, then a faster upload; missing peer fields sort last", () => {
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
            uploadSpeed: 50_000_000,
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
            // 24/48 is inside the broadcast cap and still loses: missing peer fields sort last. 192 kHz would be dropped before this rank.
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
    expect(missing?.username).toBe("zzz-known-busy");
  });

  it("prefers the file closest to the median size of the same extension", () => {
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
    expect(pick).toMatchObject({ username: "zzz-typical", size: 40 * MIB });
  });

  it("drops oversize files before the median is computed", () => {
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
    expect(pick).toMatchObject({ username: "zzz-typical", size: 40 * MIB });
  });

  it("penalizes version words on a word boundary unless the request contains that word", () => {
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
      "clean-peer",
    );
    expect(
      selectSearchResult({ responses: [remix, clean] }, { ...base, query: { title: "Song Remixed" } })?.username,
    ).toBe("clean-peer");
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
    const opts = { allowedExtensions: AUDIO };
    expect(selectSearchResult(payload, opts)).toMatchObject({ username: "mmm-cd", filename: cd, size: 40 * MIB });
    expect(selectSearchResult({ responses: [payload.responses[0]!] }, opts)).toBeNull();
    expect(selectSearchResult({ responses: [payload.responses[0]!, payload.responses[1]!] }, opts)).toMatchObject({
      username: "zzz-bare",
      filename: bare,
    });
    // Missing measurements are neutral, so the untagged file is not ranked below 16/44.1 on quality.
    expect(
      selectSearchResult(
        {
          responses: [peer("zzz-cd", cd, cdFile), peer("aaa-bare", bare, { bitRate: 1411 })],
        },
        opts,
      )?.username,
    ).toBe("aaa-bare");
    // 24/48 is at the cap and still beats 16/44.1. 192 kHz does not, unless the cap is raised.
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
      locked: 1,
      extensions: 1,
      max_file_size: 1,
      max_duration: 1,
      max_sample_rate: 1,
      max_bit_depth: 1,
    };
    expect(selectSearch(payload, opts)).toEqual({
      outcome: "no_suitable_result",
      removed,
      reason: "no_suitable_result: locked=1, extensions=1, max_file_size=1, max_duration=1, max_sample_rate=1, max_bit_depth=1",
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
});
