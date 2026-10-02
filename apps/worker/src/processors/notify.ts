import { findUserById, type Db, type RequestRow } from "@subwave-ai/db";

/**
 * Styled mode uses `text` as the operator instruction and cuts it at 300
 * characters. Facts stay inside that limit so `event` and `reason` are not
 * the lines that get cut. The wire clamp on `POST /dj/say` is still 500.
 */
export const LISTENER_FACTS_MAX_CHARS = 300;

export type NotifyRequest = Pick<RequestRow, "artist" | "title" | "raw_query" | "user_id">;

export const LISTENER_EVENTS = [
  "request_received",
  "copy_found_retrieval_started",
  "queued_coming_up",
  "request_failed",
  "request_rejected",
] as const;

export type ListenerEvent = (typeof LISTENER_EVENTS)[number];

export type ListenerFactInput = {
  event: ListenerEvent;
  /** Artist and title, or the raw query when those are not set. */
  track?: string | null;
  /** Display name already stored for the requester. Omitted when unknown. */
  requester?: string | null;
  /** Stable failure category. Omitted unless the event is a failure. */
  reason?: string | null;
};

/** Track identity for SUB/WAVE. Artist and title when set, otherwise raw_query. */
export function trackLabel(request: NotifyRequest): string {
  const named = [request.artist, request.title]
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => part.trim())
    .join(" - ");
  return named || request.raw_query.trim();
}

/** Username when request.user_id resolves; otherwise omit (never invent a name). */
export function requesterLabel(db: Db, request: NotifyRequest): string | null {
  if (!request.user_id) return null;
  const user = findUserById(db, request.user_id);
  const name = user?.username?.trim();
  return name ? name : null;
}

function factValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\r\n]+/g, " ").replace(/[ \t]+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function codePointSlice(value: string, max: number): string {
  if (max <= 0) return "";
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join("");
}

/**
 * Newline-separated facts for SUB/WAVE `POST /dj/say` (`mode: "styled"`,
 * `kind: "dj-speak"`, no `sfx`). Lines, only when they apply: `event`,
 * `track`, `requester`, `reason`. No announcer sentences. No peer, filename,
 * path, or internal id. A long artist or title is shortened first so `event`
 * and `reason` stay whole inside {@link LISTENER_FACTS_MAX_CHARS}.
 */
export function listenerFactsText(input: ListenerFactInput): string {
  const eventLine = `event: ${input.event}`;
  const reason = factValue(input.reason);
  const reasonLine = reason ? `reason: ${reason}` : null;
  let track = factValue(input.track);
  let requester = factValue(input.requester);

  const assemble = (): string => {
    const lines = [eventLine];
    if (track) lines.push(`track: ${track}`);
    if (requester) lines.push(`requester: ${requester}`);
    if (reasonLine) lines.push(reasonLine);
    return lines.join("\n");
  };

  const fit = (label: "track" | "requester"): void => {
    const current = label === "track" ? track : requester;
    if (!current) return;
    if (label === "track") track = null;
    else requester = null;
    const room = LISTENER_FACTS_MAX_CHARS - codePointLength(assemble()) - codePointLength(`\n${label}: `);
    const next = room > 0 ? codePointSlice(current, room) : "";
    if (label === "track") track = next || null;
    else requester = next || null;
  };

  if (codePointLength(assemble()) <= LISTENER_FACTS_MAX_CHARS) return assemble();
  fit("track");
  if (codePointLength(assemble()) > LISTENER_FACTS_MAX_CHARS) fit("requester");
  return assemble();
}

export function factsForRequest(
  db: Db,
  request: NotifyRequest,
  event: ListenerEvent,
  reason?: string | null,
): string {
  return listenerFactsText({
    event,
    track: trackLabel(request),
    requester: requesterLabel(db, request),
    reason,
  });
}
