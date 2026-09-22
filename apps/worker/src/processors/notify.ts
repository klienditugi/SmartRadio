import { findUserById, type Db, type RequestRow } from "@subwave-ai/db";

export type NotifyRequest = Pick<RequestRow, "artist" | "title" | "raw_query" | "user_id">;

/** Track identity for SUB/WAVE. Artist/title when set, otherwise raw_query. Not spoken copy. */
export function trackLabel(request: NotifyRequest): string {
  const named = [request.artist, request.title]
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => part.trim())
    .join(" — ");
  return named || request.raw_query.trim();
}

/** Username when request.user_id resolves; otherwise omit (never invent a name). */
export function requesterLabel(db: Db, request: NotifyRequest): string | null {
  if (!request.user_id) return null;
  const user = findUserById(db, request.user_id);
  const name = user?.username?.trim();
  return name ? name : null;
}

/**
 * Factual context for SUB/WAVE `POST /dj/say` (`mode: "styled"`).
 * Event + fields + status only — not announcer dialogue or a DJ persona.
 */
export function requestAcceptedContext(db: Db, request: NotifyRequest): string {
  const parts = ["REQUEST_ACCEPTED."];
  const requester = requesterLabel(db, request);
  if (requester) parts.push(`Requester: ${requester}.`);
  const track = trackLabel(request);
  if (track) parts.push(`Track: ${track}.`);
  parts.push("Acquisition has started.");
  return parts.join(" ");
}

export function trackReadyContext(db: Db, request: NotifyRequest): string {
  const parts = ["TRACK_READY."];
  const requester = requesterLabel(db, request);
  if (requester) parts.push(`Requester: ${requester}.`);
  const track = trackLabel(request);
  if (track) parts.push(`Track: ${track}.`);
  parts.push("Track validated and available in library for airplay.");
  return parts.join(" ");
}
