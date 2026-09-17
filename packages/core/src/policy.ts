import type { Classification, StationPolicy } from "@subwave-ai/shared";

export type PolicyDecision = {
  decision: "APPROVED" | "REJECTED";
  reasons: string[];
};

function includesInsensitive(list: readonly string[], value: string): boolean {
  const needle = value.trim().toLowerCase();
  return list.some((item) => item.trim().toLowerCase() === needle);
}

function containsTerm(haystack: string, terms: readonly string[]): string | undefined {
  const lower = haystack.toLowerCase();
  return terms.find((term) => term.trim() && lower.includes(term.trim().toLowerCase()));
}

/**
 * Deterministic station policy. Runs in application code after JSON schema
 * validation. The LLM must never approve/reject on its own.
 */
export function applyStationPolicy(classification: Classification, policy: StationPolicy): PolicyDecision {
  const reasons: string[] = [];

  if (policy.require_electronic && classification.electronic !== true) {
    reasons.push("not classified as electronic");
  }
  if (policy.require_station_match && classification.station_match !== true) {
    reasons.push("does not match station policy");
  }
  if (classification.confidence < policy.min_confidence) {
    reasons.push(`confidence ${classification.confidence} below minimum ${policy.min_confidence}`);
  }
  if (policy.allowed_genres.length > 0 && !includesInsensitive(policy.allowed_genres, classification.genre)) {
    reasons.push(`genre '${classification.genre}' is not in the allow-list`);
  }
  if (includesInsensitive(policy.blocked_artists, classification.artist)) {
    reasons.push(`artist '${classification.artist}' is blocked`);
  }
  const blockedInReason = containsTerm(
    `${classification.artist} ${classification.title} ${classification.reason}`,
    policy.blocked_terms,
  );
  if (blockedInReason) {
    reasons.push(`blocked term '${blockedInReason}'`);
  }

  if (reasons.length > 0) {
    return { decision: "REJECTED", reasons };
  }
  return { decision: "APPROVED", reasons: ["passed station policy"] };
}
