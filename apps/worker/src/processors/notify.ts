import type { RequestRow } from "@subwave-ai/db";

export type ListenerContext = Pick<RequestRow, "artist" | "title" | "raw_query">;

/** Song identity for SUB/WAVE. Context only — not a DJ script or prompt. */
export function listenerLabel(request: ListenerContext): string {
  const named = [request.artist, request.title]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" — ");
  return named || request.raw_query.trim();
}

export function requestAcceptedContext(request: ListenerContext): string {
  const label = listenerLabel(request);
  return label ? `Listener's requested song is coming: ${label}.` : "Listener's requested song is coming.";
}

export function trackReadyContext(request: ListenerContext): string {
  const label = listenerLabel(request);
  return label ? `Listener's requested song is ready: ${label}.` : "Listener's requested song is ready.";
}
