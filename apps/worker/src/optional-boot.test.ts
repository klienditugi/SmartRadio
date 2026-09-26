import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRequest, enqueueJob, getRequest, listJobs, openDatabase, transitionRequest } from "@subwave-ai/db";
import { createProviders, type FetchLike } from "@subwave-ai/providers";
import { loadConfig, type RequestStatus } from "@subwave-ai/shared";
import type { WorkerContext } from "./context.js";
import { claimAndRun } from "./dispatch.js";
import { handleHealthProbe } from "./processors/health.js";

const TO_IMPORTING: RequestStatus[] = [
  "CLASSIFYING",
  "APPROVED",
  "CHECKING_LIBRARY",
  "SEARCHING",
  "QUEUED",
  "DOWNLOADING",
  "DOWNLOAD_COMPLETE",
  "VALIDATING",
  "IMPORTING",
];

function emptyConfig() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-worker-opt-"));
  const secrets = path.join(dir, "secrets");
  mkdirSync(secrets);
  writeFileSync(path.join(secrets, "admin_password"), "x");
  writeFileSync(path.join(secrets, "session_secret"), "y");
  const cfgPath = path.join(dir, "subwave.yaml");
  writeFileSync(
    cfgPath,
    `
server:
  host: "127.0.0.1"
  port: 8788
database:
  path: ":memory:"
paths:
  secrets_dir: "${secrets}"
  downloads: "${path.join(dir, "downloads")}"
  staging: "${path.join(dir, "staging")}"
  library: "${path.join(dir, "library")}"
llm:
  base_url: ""
  model: ""
library:
  base_url: ""
  username: ""
radio:
  base_url: ""
  admin_user: ""
acquisition:
  enabled: false
worker:
  id: "worker-test"
  lease_ms: 5000
  max_attempts: 2
`,
  );
  const config = loadConfig({ configPath: cfgPath, env: {} });
  const db = openDatabase(":memory:");
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(String(url));
    throw new Error("fetch should not be called");
  };
  const ctx: WorkerContext = {
    db,
    config,
    providers: createProviders(config, fetchImpl),
    workerId: "worker-test",
  };
  return { ctx, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function advance(db: WorkerContext["db"], id: string, to: RequestStatus): void {
  const viaApproved: RequestStatus[] = ["CLASSIFYING", "APPROVED"];
  const path = to === "APPROVED" ? viaApproved : TO_IMPORTING;
  for (const status of path) {
    transitionRequest(db, { requestId: id, to: status, actor: "test" });
    if (status === to) return;
  }
  throw new Error(`unreachable status ${to}`);
}

describe("worker with unset Navidrome and SUB/WAVE", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it("loads providers and health-probes not_configured without calling the network", async () => {
    const { ctx, calls, cleanup } = emptyConfig();
    cleanups.push(cleanup);
    expect(ctx.config.library.base_url).toBe("");
    expect(ctx.config.radio.base_url).toBe("");
    expect(ctx.config.llm.model).toBe("");
    const health = (await handleHealthProbe(ctx, { id: "j", type: "health_probe" } as never)) as {
      library: { state: string; ok: boolean; detail?: string };
      radio: { state: string; ok: boolean; detail?: string };
      llm: { state: string; ok: boolean; detail?: string };
    };
    expect(health.library).toMatchObject({ state: "not_configured", ok: false });
    expect(health.radio).toMatchObject({ state: "not_configured", ok: false });
    expect(health.llm).toMatchObject({ state: "not_configured", ok: false });
    expect(health.library.detail).not.toMatch(/unreachable/);
    expect(calls).toEqual([]);
  });

  it("fails library check without searching acquisition", async () => {
    const { ctx, calls, cleanup } = emptyConfig();
    cleanups.push(cleanup);
    const request = createRequest(ctx.db, { rawQuery: "artist title" });
    advance(ctx.db, request.id, "APPROVED");
    enqueueJob(ctx.db, { type: "check_library", requestId: request.id });
    expect(await claimAndRun(ctx)).toBe(true);
    const updated = getRequest(ctx.db, request.id);
    expect(updated?.status).toBe("FAILED");
    expect(updated?.error).toBe("navidrome is not configured");
    const jobs = listJobs(ctx.db);
    expect(jobs.some((job) => job.type === "search_acquisition")).toBe(false);
    expect(jobs.find((job) => job.type === "check_library")?.error).toMatch(/navidrome is not configured/);
    expect(calls).toEqual([]);
  });

  it("fails radio say/search/queue without a false ready", async () => {
    const { ctx, calls, cleanup } = emptyConfig();
    cleanups.push(cleanup);
    const request = createRequest(ctx.db, { rawQuery: "artist title" });
    advance(ctx.db, request.id, "IMPORTING");
    enqueueJob(ctx.db, { type: "queue_radio", requestId: request.id, payload: { track_ready: true } });
    expect(await claimAndRun(ctx)).toBe(true);
    const updated = getRequest(ctx.db, request.id);
    expect(updated?.status).toBe("FAILED");
    expect(updated?.error).toBe("subwave radio is not configured");
    expect(updated?.status).not.toBe("READY");
    const jobs = listJobs(ctx.db);
    expect(jobs.filter((job) => job.type === "queue_radio")).toHaveLength(1);
    expect(jobs[0]?.error).toMatch(/subwave radio is not configured/);
    expect(calls).toEqual([]);
  });
});
