import { describe, expect, it } from "vitest";
import { createRequest, insertUser, openDatabase } from "@subwave-ai/db";
import { requestAcceptedContext, trackReadyContext } from "./notify.js";

describe("factual say context", () => {
  it("builds dry REQUEST_ACCEPTED / TRACK_READY context without announcer dialogue", () => {
    const db = openDatabase(":memory:");
    const anonymous = createRequest(db, { rawQuery: "artist title" });
    expect(requestAcceptedContext(db, { ...anonymous, artist: "Artist", title: "Title" })).toBe(
      "REQUEST_ACCEPTED. Track: Artist — Title. Acquisition has started.",
    );
    expect(trackReadyContext(db, { ...anonymous, artist: "Artist", title: "Title" })).toBe(
      "TRACK_READY. Track: Artist — Title. Track validated and available in library for airplay.",
    );
    expect(requestAcceptedContext(db, anonymous)).toBe(
      "REQUEST_ACCEPTED. Track: artist title. Acquisition has started.",
    );
    expect(requestAcceptedContext(db, { ...anonymous, artist: null, title: null, raw_query: "" })).toBe(
      "REQUEST_ACCEPTED. Acquisition has started.",
    );
  });

  it("includes requester username when request.user_id resolves; never invents a name", () => {
    const db = openDatabase(":memory:");
    const alice = insertUser(db, { username: "Alice", passwordHash: "x", role: "operator" });
    const withUser = createRequest(db, { rawQuery: "Artist - Title", userId: alice.id });
    expect(requestAcceptedContext(db, { ...withUser, artist: "Artist", title: "Title" })).toBe(
      "REQUEST_ACCEPTED. Requester: Alice. Track: Artist — Title. Acquisition has started.",
    );
    expect(trackReadyContext(db, { ...withUser, artist: "Artist", title: "Title" })).toBe(
      "TRACK_READY. Requester: Alice. Track: Artist — Title. Track validated and available in library for airplay.",
    );

    const orphan = {
      artist: null,
      title: null,
      raw_query: "orphan",
      user_id: "missing-user",
    };
    expect(requestAcceptedContext(db, orphan)).toBe(
      "REQUEST_ACCEPTED. Track: orphan. Acquisition has started.",
    );
    expect(requestAcceptedContext(db, orphan)).not.toMatch(/Requester:/);
  });
});
