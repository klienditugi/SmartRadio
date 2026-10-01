import { describe, expect, it } from "vitest";
import { createRequest, insertUser, openDatabase } from "@subwave-ai/db";
import { SAY_TEXT_MAX_CHARS } from "@subwave-ai/providers";
import { factsForRequest, listenerFactsText, requesterLabel } from "./notify.js";

describe("listener facts", () => {
  it("builds newline-separated facts and omits lines that do not apply", () => {
    const db = openDatabase(":memory:");
    const anonymous = createRequest(db, { rawQuery: "artist title" });
    expect(listenerFactsText({ event: "request_received", track: "Artist - Title" })).toBe(
      "event: request_received\ntrack: Artist - Title",
    );
    expect(factsForRequest(db, { ...anonymous, artist: "Artist", title: "Title" }, "copy_found_retrieval_started")).toBe(
      "event: copy_found_retrieval_started\ntrack: Artist - Title",
    );
    expect(factsForRequest(db, anonymous, "queued_coming_up")).toBe(
      "event: queued_coming_up\ntrack: artist title",
    );
    expect(
      factsForRequest(db, { ...anonymous, artist: null, title: null, raw_query: "" }, "request_received"),
    ).toBe("event: request_received");
    expect(listenerFactsText({ event: "request_failed", track: "Artist - Title", reason: "enqueue_failed" })).toBe(
      "event: request_failed\ntrack: Artist - Title\nreason: enqueue_failed",
    );
    expect(listenerFactsText({ event: "request_received", track: "Artist - Title" })).not.toMatch(/reason:/);
  });

  it("includes the requester display name when request.user_id resolves", () => {
    const db = openDatabase(":memory:");
    const alice = insertUser(db, { username: "Alice", passwordHash: "x", role: "operator" });
    const withUser = createRequest(db, { rawQuery: "Artist - Title", userId: alice.id });
    expect(factsForRequest(db, { ...withUser, artist: "Artist", title: "Title" }, "request_received")).toBe(
      "event: request_received\ntrack: Artist - Title\nrequester: Alice",
    );
    const orphan = {
      artist: null,
      title: null,
      raw_query: "orphan",
      user_id: "missing-user",
    };
    expect(requesterLabel(db, orphan)).toBeNull();
    expect(factsForRequest(db, orphan, "request_received")).toBe("event: request_received\ntrack: orphan");
    expect(factsForRequest(db, orphan, "request_received")).not.toMatch(/requester:/);
  });

  it("stays within 500 characters and has no filename, path, peer name, or internal id", () => {
    const db = openDatabase(":memory:");
    const alice = insertUser(db, { username: "Alice", passwordHash: "x", role: "operator" });
    const request = createRequest(db, { rawQuery: "Artist - Title", userId: alice.id });
    const named = { ...request, artist: "Artist", title: "Title" };
    const text = factsForRequest(db, named, "copy_found_retrieval_started");
    const forbidden = [request.id, alice.id, "peer-user", "secret.flac", "/music/downloads", "\\\\music\\\\track.flac"];
    for (const item of forbidden) expect(text).not.toContain(item);
    for (const line of text.split("\n")) {
      expect(line).toMatch(/^(event|track|requester): /);
    }
    expect(text).not.toMatch(/\b(filename|path|remote_user|peer)\b/i);

    const longTrack = `Artist - ${"y".repeat(800)}`;
    const capped = listenerFactsText({ event: "queued_coming_up", track: longTrack, requester: "Alice" });
    expect(Array.from(capped).length).toBeLessThanOrEqual(SAY_TEXT_MAX_CHARS);
    expect(capped.startsWith("event: queued_coming_up\ntrack: Artist - ")).toBe(true);

    const leaked = listenerFactsText({
      event: "request_failed",
      track: "Artist - Title",
      reason: "download_not_found",
    });
    expect(leaked).toBe("event: request_failed\ntrack: Artist - Title\nreason: download_not_found");
    expect(leaked).not.toContain("/");
    expect(leaked).not.toContain("\\");
  });
});
