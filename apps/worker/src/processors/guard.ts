import { getRequest, transitionRequest } from "@subwave-ai/db";
import { CONFIGURED_UNVERIFIED_MESSAGE } from "@subwave-ai/shared";
import type { JobHandler } from "../context.js";

/** Record the upgrade failure on the request, then rethrow so the job does not succeed. */
export async function runIntegration<T>(
  ctx: Parameters<JobHandler>[0],
  requestId: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (requestId && (err as Error).message === CONFIGURED_UNVERIFIED_MESSAGE) {
      const current = getRequest(ctx.db, requestId);
      if (
        current &&
        current.status !== "FAILED" &&
        current.status !== "CANCELLED" &&
        current.status !== "REJECTED" &&
        current.status !== "READY"
      ) {
        transitionRequest(ctx.db, {
          requestId,
          to: "FAILED",
          actor: ctx.workerId,
          payload: { error: CONFIGURED_UNVERIFIED_MESSAGE, outcome: "configured_unverified" },
          patch: { error: CONFIGURED_UNVERIFIED_MESSAGE },
        });
      }
    }
    throw err;
  }
}
