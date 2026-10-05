import { describe, expect, it } from "vitest";
import { openDatabase } from "./client.js";
import { claimEnqueueAttempt, claimJob, claimListenerSay, completeJob, createRequest, enqueueJob, getJob } from "./store.js";

describe("job lease", () => {
  it("lets one worker claim a job and holds the lease against a second worker", () => {
    const db = openDatabase(":memory:");
    const job = enqueueJob(db, { type: "classify", payload: { n: 1 } });
    const now = Date.now();
    const first = claimJob(db, "worker-a", 10_000, now);
    expect(first?.id).toBe(job.id);
    expect(first?.status).toBe("running");
    expect(first?.leased_by).toBe("worker-a");
    expect(first?.attempts).toBe(1);

    const second = claimJob(db, "worker-b", 10_000, now);
    expect(second).toBeNull();
  });

  it("reclaims an expired lease and records attempts", () => {
    const db = openDatabase(":memory:");
    enqueueJob(db, { type: "classify" });
    const now = Date.now();
    const first = claimJob(db, "worker-a", 50, now);
    expect(first).not.toBeNull();

    const reclaimed = claimJob(db, "worker-b", 50, now + 100);
    expect(reclaimed?.leased_by).toBe("worker-b");
    expect(reclaimed?.attempts).toBe(2);
  });

  it("re-queues a failed job until max_attempts, then marks failed", () => {
    const db = openDatabase(":memory:");
    const job = enqueueJob(db, { type: "health_probe", maxAttempts: 2 });
    const now = Date.now();
    const claimed = claimJob(db, "worker-a", 1_000, now);
    expect(claimed?.id).toBe(job.id);
    const retried = completeJob(db, { jobId: job.id, success: false, error: "boom", retryDelayMs: 10 });
    expect(retried.status).toBe("queued");

    const claimed2 = claimJob(db, "worker-a", 1_000, Date.now() + 20);
    expect(claimed2?.attempts).toBe(2);
    const failed = completeJob(db, { jobId: job.id, success: false, error: "boom again" });
    expect(failed.status).toBe("failed");
    expect(getJob(db, job.id)?.status).toBe("failed");
  });

  it("lets only one download job claim an enqueue attempt for the same file", () => {
    const db = openDatabase(":memory:");
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    const first = enqueueJob(db, { type: "download", requestId: request.id, payload: { searchId: "s" } });
    const second = enqueueJob(db, { type: "download", requestId: request.id, payload: { searchId: "s" } });
    const target = { requestId: request.id, username: "peer", filename: "\\\\music\\\\a.flac", size: 10 };
    const claimed = claimEnqueueAttempt(db, { jobId: first.id, ...target });
    expect(claimed.claimed).toBe(true);
    expect(claimed.marker).toMatchObject({ username: "peer", filename: "\\\\music\\\\a.flac", size: 10 });
    const lost = claimEnqueueAttempt(db, { jobId: second.id, ...target });
    expect(lost.claimed).toBe(false);
    expect(lost.marker).toEqual(claimed.marker);
    const again = claimEnqueueAttempt(db, { jobId: first.id, ...target });
    expect(again.claimed).toBe(false);
    const saved = JSON.parse(getJob(db, first.id)?.payload_json ?? "{}");
    expect(saved.enqueue_attempted).toEqual(claimed.marker);
    expect(JSON.parse(getJob(db, second.id)?.payload_json ?? "{}").enqueue_attempted).toBeUndefined();
  });

  it("claims one listener say per request and event", () => {
    const db = openDatabase(":memory:");
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    expect(claimListenerSay(db, { requestId: request.id, event: "request_received" })).toBe(true);
    expect(claimListenerSay(db, { requestId: request.id, event: "request_received" })).toBe(false);
    expect(claimListenerSay(db, { requestId: request.id, event: "request_failed" })).toBe(true);
    const rows = db.prepare(`SELECT event FROM listener_say_events WHERE request_id = ? ORDER BY event`).all(request.id) as Array<{
      event: string;
    }>;
    expect(rows.map((row) => row.event)).toEqual(["request_failed", "request_received"]);
  });

  it("does not claim jobs scheduled in the future", () => {
    const db = openDatabase(":memory:");
    const now = Date.now();
    enqueueJob(db, { type: "classify", runAfter: now + 50_000 });
    expect(claimJob(db, "worker-a", 1_000, now)).toBeNull();
    expect(claimJob(db, "worker-a", 1_000, now + 50_000)?.type).toBe("classify");
  });
});
