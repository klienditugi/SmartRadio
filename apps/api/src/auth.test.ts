import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testConfig, testDb } from "./test-harness.js";

describe("auth basics", () => {
  const fixtures: Array<() => void> = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.();
  });

  it("rejects bad credentials and issues a session for the seeded admin", async () => {
    const { config, cleanup } = testConfig();
    fixtures.push(cleanup);
    const db = testDb(config);
    const app = await buildApp({ config, db });
    fixtures.push(() => {
      void app.close();
    });

    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "nope" },
    });
    expect(bad.statusCode).toBe(401);

    const meAnon = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(meAnon.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "test-admin-password" },
    });
    expect(login.statusCode).toBe(200);
    const body = login.json() as { token: string; user: { username: string } };
    expect(body.user.username).toBe("admin");
    expect(body.token).toBeTruthy();

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe("admin");

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(logout.statusCode).toBe(200);

    const meAfter = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(meAfter.statusCode).toBe(401);
  });

  it("serves health, ready, doctor, and openapi", async () => {
    const { config, cleanup } = testConfig();
    fixtures.push(cleanup);
    const app = await buildApp({ config, db: testDb(config) });
    fixtures.push(() => {
      void app.close();
    });

    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe("ok");

    const ready = await app.inject({ method: "GET", url: "/api/v1/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe("ready");

    const doctor = await app.inject({ method: "GET", url: "/api/v1/doctor" });
    expect(doctor.statusCode).toBe(200);
    expect(doctor.json().ollama).toBe("external-only");
    expect(doctor.json().acquire_unavailable).toBe(true);

    const spec = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(spec.statusCode).toBe(200);
    expect(spec.json().info.title).toBe("Sub Wave AI API");
  });
});
