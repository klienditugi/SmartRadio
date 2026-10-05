import { transitionRequest, getRequest, type RequestRow } from "@subwave-ai/db";
import { isTransferTerminalFailure } from "@subwave-ai/providers";
import { CONFIGURED_UNVERIFIED_MESSAGE, NAVIDROME_NOT_CONFIGURED, SUBWAVE_RADIO_NOT_CONFIGURED } from "@subwave-ai/shared";
import type { WorkerContext } from "../context.js";
import { sayListenerFacts } from "./say-listener.js";

/**
 * Stable category for `reason:`. Never a raw error, path, filename, or peer.
 * Known codes pass through. Longer stored errors keep their code prefix.
 */
export function failureReasonCategory(message: string): string {
  const text = message.trim();
  if (text === "never-play") return "never_play";
  if (text === "no usable search result") return "no_usable_search_result";
  if (text === "no radio search result") return "no_radio_search_result";
  if (text === CONFIGURED_UNVERIFIED_MESSAGE) return "configured_unverified";
  if (text === NAVIDROME_NOT_CONFIGURED || text === SUBWAVE_RADIO_NOT_CONFIGURED) return "not_configured";
  if (text.startsWith("no_suitable_result")) return "no_suitable_result";
  if (text.startsWith("download_not_found")) return "download_not_found";
  if (text.startsWith("disallowed extension")) return "disallowed_extension";
  if (text.startsWith("download missing:")) return "download_missing";
  if (text.startsWith("invalid size")) return "invalid_size";
  if (text.startsWith("size mismatch:")) return "size_mismatch";
  if (text.startsWith("staging file already exists")) return "staging_occupied";
  if (text.startsWith("library file already exists")) return "library_occupied";
  if (text === "staging file missing") return "staging_missing";
  if (text === "validate_file missing real download basename") return "validate_missing_basename";
  if (text === "import_library missing real download basename") return "import_missing_basename";
  if (text === "download job missing searchId or selected file") return "download_missing_target";
  if (text === "download poll missing selected file correlation") return "download_missing_correlation";
  if (text.startsWith("move verification failed")) return "move_verification_failed";
  if (/^[a-z0-9_]+$/.test(text)) return text;
  if (isTransferTerminalFailure(text)) return text;
  return "request_failed";
}

/** Every move to FAILED goes through here, then one best-effort failure say. */
export async function failRequest(
  ctx: WorkerContext,
  input: {
    requestId: string;
    reason: string;
    payload?: unknown;
    patch?: Partial<Pick<RequestRow, "artist" | "title" | "genre" | "classification_json" | "policy_json" | "error">>;
  },
): Promise<RequestRow> {
  const row = transitionRequest(ctx.db, {
    requestId: input.requestId,
    to: "FAILED",
    actor: ctx.workerId,
    payload: input.payload,
    patch: input.patch,
  });
  const current = getRequest(ctx.db, input.requestId) ?? row;
  await sayListenerFacts(ctx, current, { event: "request_failed", reason: input.reason });
  return current;
}
