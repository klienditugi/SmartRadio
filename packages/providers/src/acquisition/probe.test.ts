import { describe, expect, it } from "vitest";
import type { FetchLike } from "../http.js";
import { probeSlskdConnection, readSoulseekServer } from "./probe.js";

const KEY = "probe-api-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const healthyApp = { version: { current: "0.22.5", full: "0.22.5.0" }, pendingRestart: false };

function scripted(server: unknown, application: unknown = healthyApp, applicationStatus = 200, serverStatus = 200) {
  const calls: { url: string; method?: string; key?: string | null }[] = [];
  const fetchMock: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), method: init?.method, key: headers.get("X-API-Key") });
    if (String(url).endsWith("/server")) return jsonResponse(server, serverStatus);
    return jsonResponse(application, applicationStatus);
  };
  return { calls, fetchMock };
}

describe("probeSlskdConnection", () => {
  it("marks ready only when application version and Soulseek login are both present", async () => {
    const { calls, fetchMock } = scripted({ isConnected: true, isLoggedIn: true, state: "Connected, LoggedIn" });
    const probe = await probeSlskdConnection({
      baseUrl: "http://slskd.example",
      apiKey: KEY,
      fetch: fetchMock,
    });
    expect(probe.state).toBe("ready");
    expect(probe.checks).toEqual({
      reachable: true,
      auth_ok: true,
      application_healthy: true,
      soulseek_connected: true,
      soulseek_logged_in: true,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://slskd.example/api/v0/application",
      "http://slskd.example/api/v0/server",
    ]);
    expect(calls.every((call) => call.method === "GET" && call.key === KEY)).toBe(true);
    expect(JSON.stringify(probe)).not.toContain(KEY);
  });

  it("does not treat isConnected alone as logged in", async () => {
    const { fetchMock } = scripted({ isConnected: true, isLoggedIn: false });
    const probe = await probeSlskdConnection({ baseUrl: "http://slskd.example", apiKey: KEY, fetch: fetchMock });
    expect(probe.state).toBe("soulseek_not_logged_in");
  });

  it("reports soulseek_not_connected from isConnected false", async () => {
    const { fetchMock } = scripted({ isConnected: false, isLoggedIn: false, state: "Disconnected" });
    const probe = await probeSlskdConnection({ baseUrl: "http://slskd.example", apiKey: KEY, fetch: fetchMock });
    expect(probe.state).toBe("soulseek_not_connected");
  });

  it("reads PascalCase flags and string state without treating Disconnected as Connected", async () => {
    expect(readSoulseekServer({ IsConnected: true, IsLoggedIn: true })).toEqual({
      connected: true,
      loggedIn: true,
    });
    expect(readSoulseekServer({ state: "Disconnected" })).toEqual({ connected: false, loggedIn: false });
    expect(readSoulseekServer({ state: "Connected, LoggedIn" })).toEqual({ connected: true, loggedIn: true });
    expect(readSoulseekServer({ state: "Connected" })).toEqual({ connected: true, loggedIn: false });
    expect(readSoulseekServer({ state: 10 })).toEqual({ connected: true, loggedIn: true });
    expect(readSoulseekServer({})).toEqual({ connected: null, loggedIn: null });
  });

  it("stays reachable when the application payload has no version", async () => {
    const { fetchMock } = scripted({ isConnected: true, isLoggedIn: true }, { ok: true });
    const probe = await probeSlskdConnection({ baseUrl: "http://slskd.example", apiKey: KEY, fetch: fetchMock });
    expect(probe.state).toBe("reachable");
    expect(probe.checks.application_healthy).toBe(false);
    expect(probe.checks.soulseek_logged_in).toBe(true);
  });

  it("reports auth_failed on 401 and does not echo the key", async () => {
    const { calls, fetchMock } = scripted({}, { title: "Unauthorized" }, 401);
    const probe = await probeSlskdConnection({ baseUrl: "http://slskd.example", apiKey: KEY, fetch: fetchMock });
    expect(probe.state).toBe("auth_failed");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(probe)).not.toContain(KEY);
  });

  it("reports unreachable when fetch throws", async () => {
    const fetchMock: FetchLike = async () => {
      throw new Error(`connect ECONNREFUSED ${KEY}`);
    };
    const probe = await probeSlskdConnection({ baseUrl: "http://slskd.example", apiKey: KEY, fetch: fetchMock });
    expect(probe.state).toBe("unreachable");
    expect(probe.detail).toBe("slskd unreachable");
    expect(JSON.stringify(probe)).not.toContain(KEY);
  });
});
