import { describe, expect, it } from "vitest";
import { applyStationPolicy } from "./policy.js";
import type { Classification, StationPolicy } from "@subwave-ai/shared";

const policy: StationPolicy = {
  require_electronic: true,
  require_station_match: true,
  min_confidence: 0.6,
  allowed_genres: ["techno", "house"],
  blocked_artists: ["blocked act"],
  blocked_terms: ["nsfw"],
};

const good: Classification = {
  artist: "Artist",
  title: "Track",
  genre: "techno",
  subgenres: ["minimal"],
  electronic: true,
  station_match: true,
  confidence: 0.9,
  reason: "fits the night slot",
};

describe("station policy", () => {
  it("approves a matching classification in app code", () => {
    expect(applyStationPolicy(good, policy).decision).toBe("APPROVED");
  });

  it("rejects on electronic, station_match, confidence, genre, artist, and terms", () => {
    expect(applyStationPolicy({ ...good, electronic: false }, policy).decision).toBe("REJECTED");
    expect(applyStationPolicy({ ...good, station_match: false }, policy).decision).toBe("REJECTED");
    expect(applyStationPolicy({ ...good, confidence: 0.1 }, policy).decision).toBe("REJECTED");
    expect(applyStationPolicy({ ...good, genre: "country" }, policy).decision).toBe("REJECTED");
    expect(applyStationPolicy({ ...good, artist: "Blocked Act" }, policy).decision).toBe("REJECTED");
    expect(applyStationPolicy({ ...good, reason: "contains NSFW joke" }, policy).decision).toBe("REJECTED");
  });

  it("does not treat station_match as sufficient without the rest of policy", () => {
    const result = applyStationPolicy({ ...good, electronic: false, station_match: true }, policy);
    expect(result.decision).toBe("REJECTED");
    expect(result.reasons.some((r) => r.includes("electronic"))).toBe(true);
  });
});
