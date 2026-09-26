import { describe, expect, it } from "vitest";
import { openDatabase } from "./client.js";
import { claimJob, completeJob, enqueueJob, getJob } from "./store.js";

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

  it("does not claim jobs scheduled in the future", () => {
    const db = openDatabase(":memory:");
    const now = Date.now();
    enqueueJob(db, { type: "classify", runAfter: now + 50_000 });
    expect(claimJob(db, "worker-a", 1_000, now)).toBeNull();
    expect(claimJob(db, "worker-a", 1_000, now + 50_000)?.type).toBe("classify");
  });
});
