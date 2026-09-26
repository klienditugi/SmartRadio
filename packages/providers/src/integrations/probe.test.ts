import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../http.js";
import { probeNavidromeConnection, probeOllamaConnection, probeSubwaveConnection } from "./probe.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("probeOllamaConnection", () => {
  it("is ready when GET /api/tags lists the configured model and does not pull", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      urls.push(`${init?.method ?? "GET"} ${String(url)}`);
      return jsonResponse({ models: [{ name: "station-model:latest", model: "station-model:latest" }] });
    };
    const result = await probeOllamaConnection({
      baseUrl: "http://ollama.example",
      model: "station-model:latest",
      fetch: fetchImpl,
    });
    expect(result).toEqual({ state: "ready", detail: "GET /api/tags includes the configured model" });
    expect(urls).toEqual(["GET http://ollama.example/api/tags"]);
  });

  it("reports model_missing when the tag list does not include the model", async () => {
    const result = await probeOllamaConnection({
      baseUrl: "http://ollama.example",
      model: "missing-model",
      fetch: async () => jsonResponse({ models: [{ name: "other:latest" }] }),
    });
    expect(result.state).toBe("model_missing");
  });

  it("reports unreachable when the host does not answer", async () => {
    const result = await probeOllamaConnection({
      baseUrl: "http://ollama.example",
      model: "station-model",
      fetch: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(result.state).toBe("unreachable");
  });

  it("reports auth_failed on HTTP 401", async () => {
    const result = await probeOllamaConnection({
      baseUrl: "http://ollama.example",
      model: "station-model",
      fetch: async () => jsonResponse({ error: "denied" }, 401),
    });
    expect(result.state).toBe("auth_failed");
    expect(result.detail).not.toContain("denied");
  });
});

describe("probeNavidromeConnection", () => {
  const password = "library-secret";

  it("is ready when ping status is ok and the password stays off the URL", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(String(url));
      return jsonResponse({ "subsonic-response": { status: "ok", version: "1.16.1" } });
    };
    const result = await probeNavidromeConnection({
      baseUrl: "http://navidrome.example",
      username: "nd",
      password,
      fetch: fetchImpl,
    });
    expect(result).toEqual({ state: "ready", detail: "GET /rest/ping status ok" });
    const url = new URL(urls[0] ?? "");
    expect(url.pathname).toBe("/rest/ping");
    expect(url.searchParams.get("u")).toBe("nd");
    expect(url.searchParams.get("f")).toBe("json");
    expect(url.searchParams.get("t")).toBe(
      createHash("md5").update(`${password}${url.searchParams.get("s")}`).digest("hex"),
    );
    expect(urls[0]).not.toContain(password);
  });

  it("reports auth_failed when Subsonic status is failed", async () => {
    const result = await probeNavidromeConnection({
      baseUrl: "http://navidrome.example",
      username: "nd",
      password,
      fetch: async () =>
        jsonResponse({ "subsonic-response": { status: "failed", error: { code: 40, message: password } } }),
    });
    expect(result.state).toBe("auth_failed");
    expect(result.detail).not.toContain(password);
  });

  it("reports unreachable when ping cannot connect", async () => {
    const result = await probeNavidromeConnection({
      baseUrl: "http://navidrome.example",
      username: "nd",
      password,
      fetch: async () => {
        throw new Error("timeout");
      },
    });
    expect(result.state).toBe("unreachable");
  });
});

describe("probeSubwaveConnection", () => {
  const password = "radio-secret";

  it("is ready after on-air health and a read-only admin search", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      urls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).endsWith("/health")) return jsonResponse({ status: "on-air" });
      return jsonResponse({ results: [] });
    };
    const result = await probeSubwaveConnection({
      baseUrl: "http://radio.example/api",
      adminUser: "dj",
      adminPassword: password,
      fetch: fetchImpl,
    });
    expect(result.state).toBe("ready");
    expect(urls).toEqual([
      "GET http://radio.example/api/health",
      "GET http://radio.example/api/dj/search?q=a&limit=1",
    ]);
    expect(urls.join(" ")).not.toMatch(/\/dj\/say|\/dj\/queue-track/);
  });

  it("reports auth_failed when the admin search is rejected", async () => {
    const result = await probeSubwaveConnection({
      baseUrl: "http://radio.example/api",
      adminUser: "dj",
      adminPassword: password,
      fetch: async (url) => {
        if (String(url).endsWith("/health")) return jsonResponse({ status: "on-air" });
        return jsonResponse({ error: password }, 401);
      },
    });
    expect(result.state).toBe("auth_failed");
    expect(result.detail).not.toContain(password);
  });

  it("reports unreachable when health does not answer", async () => {
    const urls: string[] = [];
    const result = await probeSubwaveConnection({
      baseUrl: "http://radio.example/api",
      adminUser: "dj",
      adminPassword: password,
      fetch: async (url) => {
        urls.push(String(url));
        throw new Error("offline");
      },
    });
    expect(result.state).toBe("unreachable");
    expect(urls).toEqual(["http://radio.example/api/health"]);
  });
});
