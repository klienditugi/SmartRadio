import { afterEach, describe, expect, it } from "vitest";
import { createRequest, enqueueJob, transitionRequest } from "@subwave-ai/db";
import { buildApp } from "./app.js";
import { testConfig, testDb } from "./test-harness.js";

async function login(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "test-admin-password" },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { token: string }).token;
}

describe("request operator API", () => {
  const fixtures: Array<() => void> = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.();
  });

  it("creates a request, exposes queue state, and supports admin actions", async () => {
    const { config, cleanup } = testConfig();
    fixtures.push(cleanup);
    const db = testDb(config);
    const app = await buildApp({ config, db, serveWeb: false });
    fixtures.push(() => {
      void app.close();
    });
    const token = await login(app);
    const headers = { authorization: `Bearer ${token}` };

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/requests",
      headers,
      payload: { text: "Artist - Track" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { request: { id: string; status: string }; job_id: string };
    expect(body.request.status).toBe("RECEIVED");
    expect(body.job_id).toBeTruthy();

    const listed = await app.inject({ method: "GET", url: "/api/v1/requests", headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().requests.length).toBe(1);

    transitionRequest(db, { requestId: body.request.id, to: "CLASSIFYING", actor: "test" });

    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/requests/${body.request.id}/approve`,
      headers,
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().request.status).toBe("APPROVED");

    const reject = await app.inject({
      method: "POST",
      url: `/api/v1/requests/${body.request.id}/reject`,
      headers,
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json().request.status).toBe("REJECTED");

    const reclassify = await app.inject({
      method: "POST",
      url: `/api/v1/requests/${body.request.id}/reclassify`,
      headers,
    });
    expect(reclassify.statusCode).toBe(200);
    expect(reclassify.json().request.status).toBe("RECEIVED");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/requests/${body.request.id}`,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().jobs.length).toBeGreaterThan(0);
    expect(detail.json().events.length).toBeGreaterThan(0);

    const overview = await app.inject({ method: "GET", url: "/api/v1/ops/overview", headers });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().disk.ok).toBe(true);
    expect(overview.json().requests_by_status.RECEIVED).toBeGreaterThan(0);

    const disk = await app.inject({ method: "GET", url: "/api/v1/ops/disk", headers });
    expect(disk.statusCode).toBe(200);
    expect(disk.json().volumes.length).toBeGreaterThan(0);

    const scan = await app.inject({ method: "POST", url: "/api/v1/admin/library/scan", headers });
    expect(scan.statusCode).toBe(201);
    expect(scan.json().job.type).toBe("index_library");
  });

  it("retries acquisition only from FAILED", async () => {
    const { config, cleanup } = testConfig();
    fixtures.push(cleanup);
    const db = testDb(config);
    const app = await buildApp({ config, db, serveWeb: false });
    fixtures.push(() => {
      void app.close();
    });
    const token = await login(app);
    const headers = { authorization: `Bearer ${token}` };
    const row = createRequest(db, { rawQuery: "fail me" });
    enqueueJob(db, { type: "search_acquisition", requestId: row.id });
    transitionRequest(db, { requestId: row.id, to: "CLASSIFYING", actor: "test" });
    transitionRequest(db, { requestId: row.id, to: "FAILED", actor: "test", patch: { error: "boom" } });

    const tooEarly = await app.inject({
      method: "POST",
      url: `/api/v1/requests/${row.id}/retry-acquisition`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(tooEarly.statusCode).toBe(200);
    expect(tooEarly.json().request.status).toBe("SEARCHING");
  });
});
