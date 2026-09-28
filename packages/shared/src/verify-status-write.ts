export const VERIFY_STATUS_WRITE_REJECTED =
  "verify_status cannot be written; verification comes only from test-connection";

export class VerifyStatusWriteError extends Error {
  readonly statusCode = 400;
  constructor() {
    super(VERIFY_STATUS_WRITE_REJECTED);
    this.name = "VerifyStatusWriteError";
  }
}

/** True when any object key, at any depth, is `verify_status`. */
export function containsVerifyStatusKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsVerifyStatusKey(item));
  for (const [key, child] of Object.entries(value)) {
    if (key === "verify_status" || containsVerifyStatusKey(child)) return true;
  }
  return false;
}

/** Copy `value` without `verify_status` keys. Non-objects are returned as-is. */
export function omitVerifyStatusKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => omitVerifyStatusKeys(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "verify_status") continue;
    out[key] = omitVerifyStatusKeys(child);
  }
  return out;
}

export function assertNoVerifyStatusKey(value: unknown): void {
  if (containsVerifyStatusKey(value)) throw new VerifyStatusWriteError();
}
