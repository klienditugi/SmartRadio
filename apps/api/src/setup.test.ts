import { afterEach, describe, expect, it } from "vitest";
import { countUsers } from "@subwave-ai/db";
import { buildApp } from "./app.js";
import { testConfig, testDb } from "./test-harness.js";

describe("setup + doctor extras", () => {
  const fixtures: Array<() => void> = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.();
  });

  it("reports setup status and disk on doctor", async () => {
    const { config, cleanup } = testConfig();
    fixtures.push(cleanup);
    const app = await buildApp({ config, db: testDb(config), serveWeb: false });
    fixtures.push(() => {
      void app.close();
    });
    const setup = await app.inject({ method: "GET", url: "/api/v1/setup" });
    expect(setup.statusCode).toBe(200);
    expect(setup.json().configured).toBe(true);
    expect(setup.json().ollama).toBe("external-only");

    const doctor = await app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(doctor.statusCode).toBe(200);
    expect(doctor.json().disk.ok).toBe(true);
    expect(doctor.json().config.paths.library).toBeTruthy();
    expect(doctor.json().acquire_unavailable).toBe(true);
    expect(doctor.json().notes.some((n: string) => n.includes("acquire_unavailable"))).toBe(true);
  });

  it("rejects anonymous setup after admin exists", async () => {
    const { config, cleanup } = testConfig();
    fixtures.push(cleanup);
    const db = testDb(config);
    const app = await buildApp({ config, db, serveWeb: false });
    fixtures.push(() => {
      void app.close();
    });
    expect(countUsers(db)).toBeGreaterThan(0);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { setup_complete: true },
    });
    expect(res.statusCode).toBe(401);
  });
});
