/**
 * Print the selector pick for every version and format preference.
 * Usage: pnpm --filter @subwave-ai/providers selector:dryrun <responses.json>
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { selectSearch, type SearchSelection } from "./select.js";

export const DRY_RUN_VERSIONS = ["balanced", "radio_edit", "original", "extended", "remix"] as const;
export const DRY_RUN_FORMATS = ["auto", "prefer_mp3", "prefer_flac", "mp3_only", "flac_only"] as const;

const AUDIO = [".mp3", ".flac", ".m4a", ".ogg", ".wav"] as const;

export type DryRunRow = {
  versionPreference: (typeof DRY_RUN_VERSIONS)[number];
  formatPreference: (typeof DRY_RUN_FORMATS)[number];
  outcome: SearchSelection["outcome"];
  username?: string;
  filename?: string;
  size?: number;
  total?: number;
  signals?: { quality: string };
  breakdown?: Record<string, number>;
  locked?: number;
  reason?: string;
};

export function selectorQuery(payload: unknown): { artist?: string; title?: string } {
  const text =
    payload && typeof payload === "object" && "searchText" in payload && typeof payload.searchText === "string"
      ? payload.searchText
      : "";
  if (/daft punk/i.test(text) && /get lucky/i.test(text)) return { artist: "Daft Punk", title: "Get Lucky" };
  if (text.trim()) return { title: text.trim() };
  return {};
}

function rowFromDecision(
  versionPreference: DryRunRow["versionPreference"],
  formatPreference: DryRunRow["formatPreference"],
  decision: SearchSelection,
): DryRunRow {
  if (decision.outcome === "selected") {
    return {
      versionPreference,
      formatPreference,
      outcome: decision.outcome,
      username: decision.file.username,
      filename: decision.file.filename,
      size: decision.file.size,
      total: decision.total,
      signals: decision.signals,
      breakdown: decision.breakdown,
      locked: decision.removed.locked,
    };
  }
  return {
    versionPreference,
    formatPreference,
    outcome: decision.outcome,
    ...(decision.outcome === "no_suitable_result" ? { reason: decision.reason, locked: decision.removed.locked } : {}),
  };
}

export function dryRunPreferences(payload: unknown): DryRunRow[] {
  const query = selectorQuery(payload);
  const rows: DryRunRow[] = [];
  for (const versionPreference of DRY_RUN_VERSIONS) {
    for (const formatPreference of DRY_RUN_FORMATS) {
      rows.push(
        rowFromDecision(
          versionPreference,
          formatPreference,
          selectSearch(payload, {
            allowedExtensions: AUDIO,
            query,
            versionPreference,
            formatPreference,
          }),
        ),
      );
    }
  }
  return rows;
}

/**
 * Extra rows for a request that names a version. The saved preference is on,
 * and it must not add points. Kept out of `dryRunPreferences` so the 5×5
 * grid stays 25 rows.
 */
export function dryRunExplicitRequests(payload: unknown): Array<DryRunRow & { queryTitle: string }> {
  const artist = selectorQuery(payload).artist;
  const cases = [
    { versionPreference: "extended" as const, queryTitle: "Get Lucky (Radio Edit)" },
    { versionPreference: "remix" as const, queryTitle: "Get Lucky (Album Version)" },
  ];
  return cases.map(({ versionPreference, queryTitle }) => {
    const formatPreference = "prefer_mp3" as const;
    const row = rowFromDecision(
      versionPreference,
      formatPreference,
      selectSearch(payload, {
        allowedExtensions: AUDIO,
        query: { ...(artist ? { artist } : {}), title: queryTitle },
        versionPreference,
        formatPreference,
      }),
    );
    return { ...row, queryTitle };
  });
}

const MIB = 1024 * 1024;

function ownerFile(input: {
  username: string;
  filename: string;
  sizeMb: number;
  ext: "mp3" | "flac";
  bitRate?: number;
  freeSlot?: boolean;
  queueLength?: number;
  uploadSpeed?: number;
}) {
  return {
    username: input.username,
    hasFreeUploadSlot: input.freeSlot ?? true,
    queueLength: input.queueLength ?? 0,
    uploadSpeed: input.uploadSpeed ?? 1_000_000,
    files: [
      {
        filename: input.filename,
        size: Math.round(input.sizeMb * MIB),
        extension: input.ext,
        length: 360,
        ...(input.bitRate !== undefined ? { bitRate: input.bitRate } : {}),
        ...(input.ext === "flac" ? { bitDepth: 16, sampleRate: 44100 } : {}),
      },
    ],
  };
}

/**
 * Synthetic owner examples. Not part of the 5×5 grid. Each row is one comparison
 * the size policy has to get right.
 */
export function dryRunOwnerExamples(): Array<DryRunRow & { scenario: string }> {
  const fast = 10 ** 9;
  const cases: Array<{
    scenario: string;
    versionPreference: DryRunRow["versionPreference"];
    formatPreference: DryRunRow["formatPreference"];
    queryTitle?: string;
    maxFileSizeMb?: number | null;
    responses: ReturnType<typeof ownerFile>[];
  }> = [
    {
      scenario: "original + prefer_flac: 14.2 MiB album MP3 vs 69.9 MiB album FLAC",
      versionPreference: "original",
      formatPreference: "prefer_flac",
      responses: [
        ownerFile({
          username: "album-mp3",
          filename: "@@share\\Album\\Get Lucky (Album Version).mp3",
          sizeMb: 14.2,
          ext: "mp3",
          bitRate: 320,
        }),
        ownerFile({
          username: "album-flac",
          filename: "@@share\\Album\\Get Lucky (Album Version).flac",
          sizeMb: 69.9,
          ext: "flac",
        }),
      ],
    },
    {
      scenario: "extended + prefer_flac: 25 MiB Club Mix MP3 vs 71.1 MiB Club Mix FLAC",
      versionPreference: "extended",
      formatPreference: "prefer_flac",
      responses: [
        ownerFile({
          username: "club-mp3",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Club Mix).mp3",
          sizeMb: 25,
          ext: "mp3",
          bitRate: 320,
        }),
        ownerFile({
          username: "club-flac",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Club Mix).flac",
          sizeMb: 71.1,
          ext: "flac",
          freeSlot: true,
          queueLength: 0,
          uploadSpeed: fast,
        }),
      ],
    },
    {
      scenario: "extended: only Club Mix is a 70 MiB FLAC vs a 10 MiB Radio Edit MP3",
      versionPreference: "extended",
      formatPreference: "prefer_mp3",
      responses: [
        ownerFile({
          username: "only-club",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Club Mix).flac",
          sizeMb: 70,
          ext: "flac",
          freeSlot: false,
          queueLength: 300,
          uploadSpeed: 1,
        }),
        ownerFile({
          username: "radio-mp3",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Radio Edit).mp3",
          sizeMb: 10,
          ext: "mp3",
          bitRate: 320,
          uploadSpeed: fast,
        }),
      ],
    },
    {
      scenario: "extended: 40 MiB Club Mix vs 10 MiB Radio Edit",
      versionPreference: "extended",
      formatPreference: "prefer_mp3",
      responses: [
        ownerFile({
          username: "mid-club",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Club Mix).flac",
          sizeMb: 40,
          ext: "flac",
        }),
        ownerFile({
          username: "small-radio",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Radio Edit).mp3",
          sizeMb: 10,
          ext: "mp3",
          bitRate: 320,
        }),
      ],
    },
    {
      scenario: "format sweep auto: 18 MiB Extended Mix MP3 vs 65 MiB Radio Edit FLAC",
      versionPreference: "extended",
      formatPreference: "auto",
      responses: [
        ownerFile({
          username: "ext-mp3",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Extended Mix).mp3",
          sizeMb: 18,
          ext: "mp3",
          bitRate: 320,
        }),
        ownerFile({
          username: "radio-flac",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Radio Edit).flac",
          sizeMb: 65,
          ext: "flac",
          uploadSpeed: fast,
        }),
      ],
    },
    {
      scenario: "format sweep prefer_mp3: 18 MiB Extended Mix MP3 vs 65 MiB Radio Edit FLAC",
      versionPreference: "extended",
      formatPreference: "prefer_mp3",
      responses: [
        ownerFile({
          username: "ext-mp3",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Extended Mix).mp3",
          sizeMb: 18,
          ext: "mp3",
          bitRate: 320,
        }),
        ownerFile({
          username: "radio-flac",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Radio Edit).flac",
          sizeMb: 65,
          ext: "flac",
          uploadSpeed: fast,
        }),
      ],
    },
    {
      scenario: "format sweep prefer_flac: 18 MiB Extended Mix MP3 vs 65 MiB Radio Edit FLAC",
      versionPreference: "extended",
      formatPreference: "prefer_flac",
      responses: [
        ownerFile({
          username: "ext-mp3",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Extended Mix).mp3",
          sizeMb: 18,
          ext: "mp3",
          bitRate: 320,
        }),
        ownerFile({
          username: "radio-flac",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Radio Edit).flac",
          sizeMb: 65,
          ext: "flac",
          uploadSpeed: fast,
        }),
      ],
    },
    {
      scenario: "format sweep mp3_only: 18 MiB Extended Mix MP3 vs 65 MiB Radio Edit FLAC",
      versionPreference: "extended",
      formatPreference: "mp3_only",
      responses: [
        ownerFile({
          username: "ext-mp3",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Extended Mix).mp3",
          sizeMb: 18,
          ext: "mp3",
          bitRate: 320,
        }),
        ownerFile({
          username: "radio-flac",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Radio Edit).flac",
          sizeMb: 65,
          ext: "flac",
          uploadSpeed: fast,
        }),
      ],
    },
    {
      scenario: "format sweep flac_only: 18 MiB Extended Mix MP3 vs 65 MiB Radio Edit FLAC",
      versionPreference: "extended",
      formatPreference: "flac_only",
      responses: [
        ownerFile({
          username: "ext-mp3",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Extended Mix).mp3",
          sizeMb: 18,
          ext: "mp3",
          bitRate: 320,
        }),
        ownerFile({
          username: "radio-flac",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Radio Edit).flac",
          sizeMb: 65,
          ext: "flac",
          uploadSpeed: fast,
        }),
      ],
    },
    {
      scenario: "radio edit request under saved extended: pure radio edit vs SYNTHETIC WBBL hybrid",
      versionPreference: "extended",
      formatPreference: "prefer_mp3",
      queryTitle: "Get Lucky (Radio Edit)",
      responses: [
        ownerFile({
          username: "pure-radio",
          filename: "@@share\\Album\\Get Lucky (Radio Edit).mp3",
          sizeMb: 10,
          ext: "mp3",
          bitRate: 320,
        }),
        ownerFile({
          username: "wbbl-hybrid",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Radio Edit - WBBL Remix).mp3",
          sizeMb: 10,
          ext: "mp3",
          bitRate: 320,
          freeSlot: false,
          queueLength: 300,
          uploadSpeed: 1,
        }),
      ],
    },
    {
      scenario: "original request under saved remix: album version vs remix",
      versionPreference: "remix",
      formatPreference: "prefer_mp3",
      queryTitle: "Get Lucky (Album Version)",
      responses: [
        ownerFile({
          username: "album-version",
          filename: "@@share\\Album\\Get Lucky (Album Version).mp3",
          sizeMb: 14,
          ext: "mp3",
          bitRate: 320,
        }),
        ownerFile({
          username: "plain-remix",
          filename: "@@share\\Album\\Get Lucky (Remix).mp3",
          sizeMb: 12,
          ext: "mp3",
          bitRate: 320,
          uploadSpeed: fast,
        }),
      ],
    },
    {
      scenario: "flac_only, caps raised: 71 MiB slower FLAC vs 224 MiB free fast FLAC",
      versionPreference: "extended",
      formatPreference: "flac_only",
      maxFileSizeMb: null,
      responses: [
        ownerFile({
          username: "small-flac",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Club Mix).flac",
          sizeMb: 71,
          ext: "flac",
          freeSlot: false,
          queueLength: 300,
          uploadSpeed: 1,
        }),
        ownerFile({
          username: "hires-flac",
          filename: "@@share\\SYNTHETIC\\Get Lucky (Club Mix).flac",
          sizeMb: 224,
          ext: "flac",
          freeSlot: true,
          queueLength: 0,
          uploadSpeed: fast,
        }),
      ],
    },
  ];
  return cases.map((item) => {
    const row = rowFromDecision(
      item.versionPreference,
      item.formatPreference,
      selectSearch(
        { responses: item.responses },
        {
          allowedExtensions: AUDIO,
          query: { artist: "Daft Punk", title: item.queryTitle ?? "Get Lucky" },
          versionPreference: item.versionPreference,
          formatPreference: item.formatPreference,
          ...(item.maxFileSizeMb !== undefined ? { maxFileSizeMb: item.maxFileSizeMb } : {}),
        },
      ),
    );
    return { ...row, scenario: item.scenario };
  });
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

function resolveInput(arg: string): string {
  if (arg.startsWith("/")) return arg;
  const fromPackage = resolve(process.cwd(), arg);
  if (existsSync(fromPackage)) return fromPackage;
  return resolve(process.env.INIT_CWD ?? process.cwd(), arg);
}

if (invokedDirectly()) {
  const path = process.argv.slice(2).find((arg) => arg !== "--" && !arg.startsWith("-"));
  if (!path) {
    console.error("usage: pnpm --filter @subwave-ai/providers selector:dryrun <responses.json>");
    process.exit(1);
  }
  const file = resolveInput(path);
  if (!existsSync(file)) {
    console.error(`selector:dryrun: no such file ${file}`);
    process.exit(1);
  }
  const payload = JSON.parse(readFileSync(file, "utf8")) as unknown;
  for (const row of dryRunPreferences(payload)) {
    console.log(JSON.stringify(row));
  }
  for (const row of dryRunExplicitRequests(payload)) {
    console.log(JSON.stringify(row));
  }
  for (const row of dryRunOwnerExamples()) {
    console.log(JSON.stringify(row));
  }
}
