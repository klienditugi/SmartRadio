import { describe, expect, it } from "vitest";
import { createRequest, insertUser, openDatabase } from "@subwave-ai/db";
import { factsForRequest, LISTENER_FACTS_MAX_CHARS, listenerFactsText, requesterLabel } from "./notify.js";

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

  it("has no filename, path, peer name, or internal id", () => {
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

    const leaked = listenerFactsText({
      event: "request_failed",
      track: "Artist - Title",
      reason: "download_not_found",
    });
    expect(leaked).toBe("event: request_failed\ntrack: Artist - Title\nreason: download_not_found");
    expect(leaked).not.toContain("/");
    expect(leaked).not.toContain("\\");
  });

  it("keeps the longest artist and title under 300 characters and still contains event and reason", () => {
    const track = `${"Artist Name".repeat(40)} - ${"Title Name".repeat(40)}`;
    const text = listenerFactsText({
      event: "copy_found_retrieval_started",
      track,
      requester: "Alice",
      reason: "ffprobe_duration_mismatch",
    });
    expect(Array.from(text).length).toBeLessThanOrEqual(LISTENER_FACTS_MAX_CHARS);
    expect(LISTENER_FACTS_MAX_CHARS).toBe(300);
    expect(text.startsWith("event: copy_found_retrieval_started\n")).toBe(true);
    expect(text.endsWith("\nreason: ffprobe_duration_mismatch")).toBe(true);
    const lines = text.split("\n");
    expect(lines.filter((line) => line.startsWith("event: "))).toEqual(["event: copy_found_retrieval_started"]);
    expect(lines.filter((line) => line.startsWith("reason: "))).toEqual(["reason: ffprobe_duration_mismatch"]);
    const trackLine = lines.find((line) => line.startsWith("track: "));
    expect(trackLine).toBeTruthy();
    expect(Array.from(trackLine ?? "").length).toBeLessThan(Array.from(`track: ${track}`).length);
    expect(trackLine?.startsWith("track: Artist Name")).toBe(true);
  });
});
