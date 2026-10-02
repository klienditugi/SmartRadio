/**
 * Navidrome and SUB/WAVE ids are strings once SmartRadio has parsed them.
 * `getMusicFolders` returns folder id `1` as a JSON number. A finite number
 * becomes its decimal string. Anything else that is not a non-empty string is
 * not an id.
 */
export function providerId(value: unknown): string | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}
