import { claimListenerSay } from "@subwave-ai/db";
import type { WorkerContext } from "../context.js";
import { factsForRequest, type ListenerEvent, type NotifyRequest } from "./notify.js";

/**
 * Best-effort listener say. Claims the event first. A lost claim or a failed
 * send returns without throwing and without changing request state. A failed
 * send is not retried.
 */
export async function sayListenerFacts(
  ctx: WorkerContext,
  request: NotifyRequest & { id: string },
  input: { event: ListenerEvent; reason?: string },
): Promise<void> {
  let claimed = false;
  try {
    claimed = claimListenerSay(ctx.db, { requestId: request.id, event: input.event });
  } catch {
    console.error(`listener say claim failed event=${input.event}`);
    return;
  }
  if (!claimed) return;
  try {
    const text = factsForRequest(ctx.db, request, input.event, input.reason);
    await ctx.providers.radio.say({ text, kind: "dj-speak" });
  } catch {
    const reason = input.reason ? ` reason=${input.reason}` : "";
    console.error(`listener say failed event=${input.event}${reason}`);
  }
}
