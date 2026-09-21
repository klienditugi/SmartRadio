import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CLASSIFICATION_JSON_SCHEMA } from "@subwave-ai/shared";
import { OllamaProvider } from "./llm/ollama.js";
import { NavidromeProvider } from "./library/navidrome.js";
import { SubWaveProvider } from "./radio/subwave.js";
import { SoulseekProvider } from "./acquisition/slskd.js";
import { UnverifiedAcquisitionProvider } from "./acquisition/unverified.js";
import { UnverifiedAdapterError } from "./http.js";
import type { FetchLike } from "./http.js";

function jsonResponse(body: unknown, status = 200, url = "http://example"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const classification = {
  artist: "A",
  title: "T",
  genre: "techno",
  subgenres: [],
  electronic: true,
  station_match: true,
  confidence: 0.8,
  reason: "ok",
};

describe("OllamaProvider", () => {
  it("POSTs /api/chat with stream:false and JSON schema format; never pull/tags for classify", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ message: { content: JSON.stringify(classification) } });
    };
    const llm = new OllamaProvider({
      baseUrl: "http://ollama.example:11434",
      model: "configured-from-env",
      fetch: fetchMock,
    });
    const result = await llm.classify({ text: "play some techno" });
    expect(result.artist).toBe("A");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://ollama.example:11434/api/chat");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.stream).toBe(false);
    expect(body.model).toBe("configured-from-env");
    expect(body.format).toEqual(CLASSIFICATION_JSON_SCHEMA);
    expect(body.messages[0].content).toMatch(/Do not run tools/);
    expect(JSON.stringify(body)).not.toMatch(/\/api\/pull/);
  });

  it("health uses GET /api/version (and does not pull models)", async () => {
    const urls: string[] = [];
    const fetchMock: FetchLike = async (url) => {
      urls.push(String(url));
      return jsonResponse({ version: "0.0.0" });
    };
    const llm = new OllamaProvider({ baseUrl: "http://ollama.example", model: "x", fetch: fetchMock });
    const health = await llm.health();
    expect(health.ok).toBe(true);
    expect(urls).toEqual(["http://ollama.example/api/version"]);
  });
});

describe("NavidromeProvider", () => {
  it("calls {url}/rest/search3 with f=json and u+t/s md5 token, IDs as strings", async () => {
    const seen: URL[] = [];
    const fetchMock: FetchLike = async (url) => {
      seen.push(new URL(String(url)));
      return jsonResponse({
        "subsonic-response": {
          status: "ok",
          version: "1.16.1",
          searchResult3: { song: [{ id: 99, title: "Song", artist: "Act" }] },
        },
      });
    };
    const nd = new NavidromeProvider({
      baseUrl: "http://navidrome.example",
      username: "user",
      password: "secret",
      fetch: fetchMock,
    });
    const songs = await nd.search3("query");
    expect(songs[0]?.id).toBe("99");
    const u = seen[0];
    expect(u?.pathname).toBe("/rest/search3");
    expect(u?.searchParams.get("f")).toBe("json");
    expect(u?.searchParams.get("u")).toBe("user");
    expect(u?.searchParams.get("v")).toBe("1.16.1");
    const salt = u?.searchParams.get("s") ?? "";
    const token = u?.searchParams.get("t") ?? "";
    expect(salt.length).toBeGreaterThanOrEqual(6);
    expect(token).toBe(createHash("md5").update(`secret${salt}`).digest("hex"));
  });

  it("uses verified scan methods only", async () => {
    const paths: string[] = [];
    const fetchMock: FetchLike = async (url) => {
      paths.push(new URL(String(url)).pathname);
      return jsonResponse({ "subsonic-response": { status: "ok", scanStatus: { scanning: false } } });
    };
    const nd = new NavidromeProvider({
      baseUrl: "http://navidrome.example",
      username: "u",
      password: "p",
      fetch: fetchMock,
    });
    await nd.getScanStatus();
    await nd.startScan({ fullScan: true });
    await nd.getSong("abc");
    expect(paths).toEqual(["/rest/getScanStatus", "/rest/startScan", "/rest/getSong"]);
  });
});

describe("SubWaveProvider", () => {
  it("uses opaque base_url and admin Basic for /dj/search and /dj/queue-track", async () => {
    const calls: { url: string; method?: string; auth?: string }[] = [];
    const fetchMock: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), method: init?.method, auth: headers.get("authorization") ?? undefined });
      return jsonResponse({ results: [], hasMore: false, ok: true });
    };
    const radio = new SubWaveProvider({
      baseUrl: "http://station.example:7700/api",
      adminUser: "admin",
      adminPassword: "pass",
      fetch: fetchMock,
    });
    await radio.djSearch("bowie", { limit: 10 });
    await radio.queueTrack({ id: "t1", title: "Heroes", artist: "Bowie" });
    await radio.refreshPlaylist();
    expect(calls[0]?.url).toContain("http://station.example:7700/api/dj/search");
    expect(calls[0]?.url).toContain("q=bowie");
    expect(calls[0]?.auth).toMatch(/^Basic /);
    expect(calls[1]?.url).toBe("http://station.example:7700/api/dj/queue-track");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[2]?.url).toBe("http://station.example:7700/api/dj/refresh-playlist");
  });

  it("exposes verified public health/now-playing/state and secondary /request", async () => {
    const urls: string[] = [];
    const fetchMock: FetchLike = async (url, init) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      return jsonResponse({ status: "on-air", success: true, requestId: "abc", statusCode: "pending" });
    };
    const radio = new SubWaveProvider({
      baseUrl: "http://station.example/api",
      adminUser: "a",
      adminPassword: "b",
      fetch: fetchMock,
    });
    await radio.health();
    await radio.nowPlaying();
    await radio.state();
    await radio.publicRequest({ text: "something slower", name: "alex" });
    expect(urls).toEqual([
      "GET http://station.example/api/health",
      "GET http://station.example/api/now-playing",
      "GET http://station.example/api/state",
      "POST http://station.example/api/request",
    ]);
  });
});

describe("SoulseekProvider (slskd)", () => {
  it("uses /api/v0, X-API-Key, POST /searches and POST /transfers/downloads/{user}", async () => {
    const calls: { url: string; method?: string; key?: string }[] = [];
    const fetchMock: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), method: init?.method, key: headers.get("X-API-Key") ?? undefined });
      if (init?.method === "POST" && String(url).includes("/transfers/")) {
        return new Response(null, { status: 201 });
      }
      return jsonResponse({ id: "s1" });
    };
    const slskd = new SoulseekProvider({
      baseUrl: "http://slskd.example",
      apiKey: "key-from-secrets",
      fetch: fetchMock,
    });
    await slskd.search("artist title", "search-1");
    await slskd.enqueueDownload("peer", [{ filename: "a.flac", size: 1 }]);
    await slskd.listDownloads();
    expect(calls[0]?.url).toBe("http://slskd.example/api/v0/searches");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.key).toBe("key-from-secrets");
    expect(calls[1]?.url).toBe("http://slskd.example/api/v0/transfers/downloads/peer");
    expect(calls[2]?.url).toBe("http://slskd.example/api/v0/transfers/downloads");
  });

  it("unverified acquisition never calls fetch", async () => {
    const unverified = new UnverifiedAcquisitionProvider();
    await expect(unverified.search("x", "id")).rejects.toBeInstanceOf(UnverifiedAdapterError);
    const health = await unverified.health();
    expect(health.verifyStatus).toBe("unverified");
    expect(health.ok).toBe(false);
  });
});
