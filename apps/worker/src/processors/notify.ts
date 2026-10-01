import { findUserById, type Db, type RequestRow } from "@subwave-ai/db";
import { SAY_TEXT_MAX_CHARS } from "@subwave-ai/providers";

export type NotifyRequest = Pick<RequestRow, "artist" | "title" | "raw_query" | "user_id">;

export const LISTENER_EVENTS = [
  "request_received",
  "copy_found_retrieval_started",
  "queued_coming_up",
  "request_failed",
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

/**
 * Newline-separated facts for SUB/WAVE `POST /dj/say` (`mode: "styled"`).
 * Lines, only when they apply: `event`, `track`, `requester`, `reason`.
 * No announcer sentences. No peer, filename, path, or internal id.
 */
export function listenerFactsText(input: ListenerFactInput): string {
  const lines = [`event: ${input.event}`];
  const track = factValue(input.track);
  if (track) lines.push(`track: ${track}`);
  const requester = factValue(input.requester);
  if (requester) lines.push(`requester: ${requester}`);
  const reason = factValue(input.reason);
  if (reason) lines.push(`reason: ${reason}`);
  const text = lines.join("\n");
  const chars = Array.from(text);
  if (chars.length <= SAY_TEXT_MAX_CHARS) return text;
  return chars.slice(0, SAY_TEXT_MAX_CHARS).join("");
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
