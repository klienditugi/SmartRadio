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
}
