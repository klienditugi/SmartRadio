/**
 * Print the selector pick for the practical version and format grid.
 * Usage: pnpm --filter @subwave-ai/providers selector:dryrun <responses.json>
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { selectSearch, type SearchSelection } from "./select.js";

/** Default (`balanced`) plus the saved classes. `auto` is not in this grid. */
export const DRY_RUN_VERSIONS = ["balanced", "original", "extended", "remix", "radio_edit"] as const;
export const DRY_RUN_FORMATS = ["prefer_mp3", "prefer_flac", "mp3_only", "flac_only"] as const;

const AUDIO = [".mp3", ".flac", ".m4a", ".ogg", ".wav"] as const;
const MIB = 1024 * 1024;

export type DryRunRow = {
  versionPreference: (typeof DRY_RUN_VERSIONS)[number];
  formatPreference: (typeof DRY_RUN_FORMATS)[number];
  outcome: SearchSelection["outcome"];
  username?: string;
  filename?: string;
  basename?: string;
  versionClass?: string;
  sizeMiB?: number;
  format?: string;
  bitrateKbps?: number;
  titleMatch?: number;
  artistInPath?: number;
  removed?: Extract<SearchSelection, { removed: unknown }>["removed"];
  reason?: string;
  queryTitle?: string;
};

function searchTextOf(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["searchText", "SearchText", "search_text"]) {
    if (typeof record[key] === "string") return record[key];
  }
  const nested = record.search ?? record.Search;
  if (nested && typeof nested === "object") return searchTextOf(nested);
  return "";
}

export function selectorQuery(payload: unknown): { artist?: string; title?: string } {
  const text = searchTextOf(payload);
  if (/daft punk/i.test(text) && /get lucky/i.test(text)) return { artist: "Daft Punk", title: "Get Lucky" };
  if (text.trim()) return { title: text.trim() };
  return {};
}

function basenameOf(filename: string): string {
  const parts = filename.split(/[/\\]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? filename;
}

function rowFromDecision(
  versionPreference: DryRunRow["versionPreference"],
  formatPreference: DryRunRow["formatPreference"],
  decision: SearchSelection,
): DryRunRow {
  if (decision.outcome === "selected") {
    const bitrate = decision.file.bitRate ?? decision.pick.bitrateKbps;
    return {
      versionPreference,
      formatPreference,
      outcome: decision.outcome,
      username: decision.file.username,
      filename: decision.file.filename,
      basename: basenameOf(decision.file.filename),
      versionClass: decision.versionClass,
      sizeMiB: Math.round((decision.file.size / MIB) * 100) / 100,
      format: decision.file.extension ?? decision.pick.format.ext,
      ...(bitrate !== undefined ? { bitrateKbps: bitrate } : {}),
      titleMatch: decision.breakdown.titleMatch,
      artistInPath: decision.breakdown.artistInPath,
      removed: decision.removed,
    };
  }
  if (decision.outcome === "no_suitable_result") {
    return {
      versionPreference,
      formatPreference,
      outcome: decision.outcome,
      reason: decision.reason,
      removed: decision.removed,
    };
  }
  return { versionPreference, formatPreference, outcome: decision.outcome };
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
 * A version written in the request turns the saved preference off.
 * Kept out of the 5×4 grid.
 */
export function dryRunExplicitRequests(payload: unknown): DryRunRow[] {
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
  for (const row of dryRunPreferences(payload)) console.log(JSON.stringify(row));
  for (const row of dryRunExplicitRequests(payload)) console.log(JSON.stringify(row));
}
