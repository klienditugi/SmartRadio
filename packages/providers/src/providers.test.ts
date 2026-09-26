import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CLASSIFICATION_JSON_SCHEMA, parseAppConfig, type RuntimeConfig } from "@subwave-ai/shared";
import { createProviders } from "./factory.js";
import { OllamaProvider } from "./llm/ollama.js";
import { NavidromeProvider } from "./library/navidrome.js";
import { NeverPlayError, SubWaveProvider } from "./radio/subwave.js";
import { SoulseekProvider } from "./acquisition/slskd.js";
import { UnverifiedAcquisitionProvider } from "./acquisition/unverified.js";
import { NotConfiguredError, UnverifiedAdapterError } from "./http.js";
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
      verifyStatus: "verified",
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
    const llm = new OllamaProvider({
      baseUrl: "http://ollama.example",
      model: "x",
      verifyStatus: "verified",
      fetch: fetchMock,
    });
    const health = await llm.health();
    expect(health.ok).toBe(true);
    expect(urls).toEqual(["http://ollama.example/api/version"]);
  });

  it("omits verifyStatus as unverified and does not call fetch", async () => {
    const llm = new OllamaProvider({
      baseUrl: "http://ollama.example",
      model: "x",
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });
    expect(llm.verifyStatus).toBe("unverified");
    await expect(llm.classify({ text: "play something" })).rejects.toThrow(/configured but unverified, run test connection/);
    const health = await llm.health();
    expect(health.ok).toBe(false);
    expect(health.verifyStatus).toBe("unverified");
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
      verifyStatus: "verified",
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
      verifyStatus: "verified",
      fetch: fetchMock,
    });
    await nd.getScanStatus();
    await nd.startScan({ fullScan: true });
    await nd.getSong("abc");
    expect(paths).toEqual(["/rest/getScanStatus", "/rest/startScan", "/rest/getSong"]);
  });

  it("omits verifyStatus as unverified and does not call fetch", async () => {
    const nd = new NavidromeProvider({
      baseUrl: "http://navidrome.example",
      username: "u",
      password: "p",
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });
    expect(nd.verifyStatus).toBe("unverified");
    await expect(nd.search3("q")).rejects.toThrow(/configured but unverified, run test connection/);
    const health = await nd.health();
    expect(health.ok).toBe(false);
    expect(health.verifyStatus).toBe("unverified");
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
      verifyStatus: "verified",
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
      verifyStatus: "verified",
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

  it("POSTs /dj/say with admin Basic, mode styled, and parses {ok,mode,kind,spoken,sfx}", async () => {
    const calls: { url: string; method?: string; auth?: string; body?: string }[] = [];
    const fetchMock: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        method: init?.method,
        auth: headers.get("authorization") ?? undefined,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return jsonResponse({ ok: true, mode: "styled", kind: "dj-speak", spoken: "on the way", sfx: null });
    };
    const radio = new SubWaveProvider({
      baseUrl: "http://station.example:7700/api/",
      adminUser: "admin",
      adminPassword: "pass",
      verifyStatus: "verified",
      fetch: fetchMock,
    });
    const result = await radio.say({ text: "  Listener's requested song is coming.  " });
    expect(result).toEqual({ ok: true, mode: "styled", kind: "dj-speak", spoken: "on the way", sfx: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://station.example:7700/api/dj/say");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from("admin:pass").toString("base64")}`);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      text: "Listener's requested song is coming.",
      mode: "styled",
      kind: "dj-speak",
    });
  });

  it("defaults kind to dj-speak, allows link, forwards sfx, and truncates text to 500 characters", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const kind = bodies.at(-1)?.kind;
      return jsonResponse({ ok: true, mode: "styled", kind, spoken: "ok", sfx: bodies.at(-1)?.sfx ?? null });
    };
    const radio = new SubWaveProvider({
      baseUrl: "http://station.example/api",
      adminUser: "a",
      adminPassword: "b",
      verifyStatus: "verified",
      fetch: fetchMock,
    });
    await radio.say({ text: "context", kind: "link", sfx: { cue: "sting" } });
    await radio.say({ text: ` ${"y".repeat(501)} ` });
    expect(bodies[0]).toEqual({ text: "context", mode: "styled", kind: "link", sfx: { cue: "sting" } });
    expect(bodies[1]?.mode).toBe("styled");
    expect(bodies[1]?.kind).toBe("dj-speak");
    expect(bodies[1]?.text).toBe("y".repeat(500));
    expect(bodies[1]?.sfx).toBeUndefined();
  });

  it("rejects empty text, unsupported kind, unverified adapters, and a non-success say body without calling a guessed URL", async () => {
    let calls = 0;
    const fetchMock: FetchLike = async () => {
      calls += 1;
      return jsonResponse({ ok: false, mode: "styled", kind: "dj-speak", spoken: "" });
    };
    const radio = new SubWaveProvider({
      baseUrl: "http://station.example/api",
      adminUser: "a",
      adminPassword: "b",
      verifyStatus: "verified",
      fetch: fetchMock,
    });
    await expect(radio.say({ text: "   " })).rejects.toThrow(/required/);
    await expect(radio.say({ text: "context", kind: "voiceover" as "dj-speak" })).rejects.toThrow(/unsupported say kind/);
    expect(calls).toBe(0);
    await expect(radio.say({ text: "context" })).rejects.toThrow(/invalid \/dj\/say response/);
    expect(calls).toBe(1);

    const unverified = new SubWaveProvider({
      baseUrl: "http://station.example/api",
      adminUser: "a",
      adminPassword: "b",
      verifyStatus: "unverified",
      fetch: async () => {
        throw new Error("live fetch");
      },
    });
    await expect(unverified.say({ text: "context" })).rejects.toThrow(/configured but unverified, run test connection/);

    const omitted = new SubWaveProvider({
      baseUrl: "http://station.example/api",
      adminUser: "a",
      adminPassword: "b",
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });
    expect(omitted.verifyStatus).toBe("unverified");
    await expect(omitted.health()).resolves.toMatchObject({ ok: false, verifyStatus: "unverified" });
    await expect(omitted.say({ text: "context" })).rejects.toThrow(/configured but unverified, run test connection/);
  });

  it("sends optional album on queue-track and treats HTTP 409 as never-play", async () => {
    const bodies: unknown[] = [];
    const fetchMock: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) return jsonResponse({ ok: true });
      return new Response("blocked", { status: 409 });
    };
    const radio = new SubWaveProvider({
      baseUrl: "http://station.example/api",
      adminUser: "a",
      adminPassword: "b",
      verifyStatus: "verified",
      fetch: fetchMock,
    });
    await radio.queueTrack({ id: "t1", title: "Heroes", artist: "Bowie", album: "Lodger" });
    await expect(radio.queueTrack({ id: "t2", title: "Nope" })).rejects.toBeInstanceOf(NeverPlayError);
    expect(bodies[0]).toEqual({ id: "t1", title: "Heroes", artist: "Bowie", album: "Lodger" });
    expect(bodies[1]).toEqual({ id: "t2", title: "Nope" });
  });
});

describe("SoulseekProvider (slskd)", () => {
  it("uses /api/v0, X-API-Key, POST /searches, poll search, POST /transfers/downloads/{user}", async () => {
    const calls: { url: string; method?: string; key?: string }[] = [];
    const fetchMock: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), method: init?.method, key: headers.get("X-API-Key") ?? undefined });
      if (init?.method === "POST" && String(url).includes("/transfers/")) {
        return new Response(null, { status: 201 });
      }
      return jsonResponse({ id: "s1", isComplete: true, responses: [] });
    };
    const slskd = new SoulseekProvider({
      baseUrl: "http://slskd.example",
      apiKey: "key-from-secrets",
      fetch: fetchMock,
    });
    await slskd.search("artist title", "search-1");
    await slskd.getSearch("search-1", { includeResponses: true });
    await slskd.getSearchResponses("search-1");
    await slskd.enqueueDownload("peer", [{ filename: "a.flac", size: 1 }]);
    await slskd.listDownloads();
    expect(calls[0]?.url).toBe("http://slskd.example/api/v0/searches");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.key).toBe("key-from-secrets");
    expect(calls[1]?.url).toBe("http://slskd.example/api/v0/searches/search-1?includeResponses=true");
    expect(calls[2]?.url).toBe("http://slskd.example/api/v0/searches/search-1/responses");
    expect(calls[3]?.url).toBe("http://slskd.example/api/v0/transfers/downloads/peer");
    expect(calls[4]?.url).toBe("http://slskd.example/api/v0/transfers/downloads");
  });

  it("enqueues the original filename verbatim and the size", async () => {
    const filename = "C:\\Users\\share\\Album\\01 Get Lucky.flac";
    let body = "";
    let method: string | undefined;
    let url = "";
    const fetchMock: FetchLike = async (input, init) => {
      url = String(input);
      method = init?.method;
      body = String(init?.body ?? "");
      return new Response(null, { status: 201 });
    };
    const slskd = new SoulseekProvider({
      baseUrl: "http://slskd.example",
      apiKey: "key-from-secrets",
      fetch: fetchMock,
    });
    await slskd.enqueueDownload("peer", [{ filename, size: 44_000_000 }]);
    expect(method).toBe("POST");
    expect(url).toBe("http://slskd.example/api/v0/transfers/downloads/peer");
    expect(JSON.parse(body)).toEqual([{ filename, size: 44_000_000 }]);
    expect(body).toContain("C:\\\\Users\\\\share\\\\Album\\\\01 Get Lucky.flac");
    expect(body).not.toContain("C:/Users");
    expect(JSON.parse(body)[0].filename).not.toBe("01 Get Lucky.flac");
  });

  it("health prefers GET /application and GET /server and requires Soulseek login", async () => {
    const calls: string[] = [];
    const fetchMock: FetchLike = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/server")) return jsonResponse({ isConnected: true, isLoggedIn: true });
      return jsonResponse({ version: { current: "0.22.5", full: "0.22.5.0" } });
    };
    const slskd = new SoulseekProvider({
      baseUrl: "http://slskd.example",
      apiKey: "key",
      fetch: fetchMock,
    });
    const health = await slskd.health();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain("connected and logged in");
    expect(calls).toEqual([
      "http://slskd.example/api/v0/application",
      "http://slskd.example/api/v0/server",
    ]);
  });

  it("health is not ok when Soulseek is connected but not logged in", async () => {
    const fetchMock: FetchLike = async (url) => {
      if (String(url).endsWith("/server")) return jsonResponse({ isConnected: true, isLoggedIn: false });
      return jsonResponse({ version: { current: "0.22.5" } });
    };
    const slskd = new SoulseekProvider({
      baseUrl: "http://slskd.example",
      apiKey: "key",
      fetch: fetchMock,
    });
    const health = await slskd.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("not logged in");
  });

  it("unverified SoulseekProvider does not call live endpoints", async () => {
    const fetchMock: FetchLike = async () => {
      throw new Error("fetch should not be called");
    };
    const slskd = new SoulseekProvider({
      baseUrl: "http://slskd.example",
      apiKey: "key",
      verifyStatus: "unverified",
      fetch: fetchMock,
    });
    const health = await slskd.health();
    expect(health.ok).toBe(false);
    expect(health.verifyStatus).toBe("unverified");
  });

  it("unverified acquisition never calls fetch", async () => {
    const unverified = new UnverifiedAcquisitionProvider();
    await expect(unverified.search("x", "id")).rejects.toBeInstanceOf(UnverifiedAdapterError);
    await expect(unverified.getSearch("x")).rejects.toBeInstanceOf(UnverifiedAdapterError);
    const health = await unverified.health();
    expect(health.verifyStatus).toBe("unverified");
    expect(health.ok).toBe(false);
  });
});

describe("createProviders acquisition gate", () => {
  function runtime(acquisition: Partial<RuntimeConfig["acquisition"]>): RuntimeConfig {
    return {
      llm: {
        provider: "ollama",
        base_url: "http://ollama",
        model: "m",
        timeout_ms: 1000,
        verify_status: "verified",
      },
      library: {
        provider: "navidrome",
        base_url: "http://nd",
        username: "u",
        client_name: "c",
        api_version: "1.16.1",
        verify_status: "verified",
      },
      radio: {
        provider: "subwave",
        base_url: "http://radio/api",
        admin_user: "dj",
        verify_status: "verified",
      },
      acquisition: {
        enabled: true,
        provider: "slskd",
        base_url: "http://slskd.example",
        verify_status: "verified",
        ...acquisition,
      },
      secrets: { slskdApiKey: "k" },
    } as RuntimeConfig;
  }

  it("leaves llm, library, and radio unverified when config omits verify_status", async () => {
    let called = false;
    const parsed = parseAppConfig({
      server: { host: "127.0.0.1", port: 8788 },
      database: { path: ":memory:" },
      paths: { secrets_dir: "./secrets", downloads: "./dl", staging: "./st", library: "./lib" },
      llm: { base_url: "http://ollama.example", model: "m" },
      library: { base_url: "http://nd.example", username: "u" },
      radio: { base_url: "http://radio.example/api", admin_user: "dj" },
      acquisition: { provider: "slskd", base_url: "", verify_status: "unverified" },
    });
    const providers = createProviders({ ...parsed, secrets: {} }, async () => {
      called = true;
      throw new Error("fetch should not be called");
    });
    expect(parsed.llm.verify_status).toBe("unverified");
    expect(parsed.library.verify_status).toBe("unverified");
    expect(parsed.radio.verify_status).toBe("unverified");
    expect(providers.llm.verifyStatus).toBe("unverified");
    expect(providers.library.verifyStatus).toBe("unverified");
    expect(providers.radio.verifyStatus).toBe("unverified");
    await expect(providers.llm.classify({ text: "track" })).rejects.toThrow(/configured but unverified, run test connection/);
    await expect(providers.library.search3("track")).rejects.toThrow(/unverified library adapter/);
    await expect(providers.radio.say({ text: "track" })).rejects.toThrow(/unverified radio adapter/);
    expect(called).toBe(false);
  });

  it("uses Soulseek only when enabled and provider is slskd", () => {
    expect(createProviders(runtime({})).acquisition.kind).toBe("slskd");
    expect(createProviders(runtime({ enabled: false })).acquisition.kind).toBe("unverified");
    expect(createProviders(runtime({ provider: "other-daemon" })).acquisition.kind).toBe("unverified");
  });
});

describe("integrations that are not configured", () => {
  it("does not call Navidrome and returns not_configured, distinct from unreachable", async () => {
    let calls = 0;
    const fetchMock: FetchLike = async () => {
      calls += 1;
      throw new Error("connect ECONNREFUSED");
    };
    const missing = new NavidromeProvider({
      baseUrl: "  ",
      username: "",
      password: "",
      fetch: fetchMock,
    });
    const health = await missing.health();
    expect(health.state).toBe("not_configured");
    expect(health.ok).toBe(false);
    expect(health.detail).toBe("navidrome is not configured");
    await expect(missing.search3("query")).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(missing.getSong("1")).rejects.toThrow(/navidrome is not configured/);
    expect(calls).toBe(0);

    const partial = new NavidromeProvider({
      baseUrl: "http://navidrome.example",
      username: "nd",
      password: "   ",
      fetch: fetchMock,
    });
    expect((await partial.health()).state).toBe("not_configured");
    expect(calls).toBe(0);

    const down = new NavidromeProvider({
      baseUrl: "http://navidrome.example",
      username: "nd",
      password: "secret",
      fetch: fetchMock,
    });
    const unreachable = await down.health();
    expect(unreachable.state).toBe("unreachable");
    expect(unreachable.detail).not.toMatch(/not configured/);
    expect(calls).toBe(1);
  });

  it("does not call SUB/WAVE say, search, or queue-track when unset", async () => {
    let calls = 0;
    const fetchMock: FetchLike = async () => {
      calls += 1;
      throw new Error("connect ECONNREFUSED");
    };
    const radio = new SubWaveProvider({
      baseUrl: "",
      adminUser: "",
      adminPassword: "",
      fetch: fetchMock,
    });
    expect((await radio.health()).state).toBe("not_configured");
    await expect(radio.say({ text: "REQUEST_ACCEPTED. Track: A — T." })).rejects.toThrow(/subwave radio is not configured/);
    await expect(radio.djSearch("query")).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(radio.queueTrack({ id: "1", title: "T" })).rejects.toThrow(/subwave radio is not configured/);
    expect(calls).toBe(0);

    const down = new SubWaveProvider({
      baseUrl: "http://radio.example/api",
      adminUser: "dj",
      adminPassword: "secret",
      fetch: fetchMock,
    });
    expect((await down.health()).state).toBe("unreachable");
    expect(calls).toBe(1);
  });

  it("does not call Ollama or invent a model when URL and model are empty", async () => {
    let calls = 0;
    const fetchMock: FetchLike = async () => {
      calls += 1;
      throw new Error("connect ECONNREFUSED");
    };
    const llm = new OllamaProvider({ baseUrl: "", model: "", fetch: fetchMock });
    const health = await llm.health();
    expect(health.state).toBe("not_configured");
    expect(health.detail).toMatch(/refusing to hard-code a model name/);
    await expect(llm.classify({ text: "play techno" })).rejects.toBeInstanceOf(NotConfiguredError);
    expect(calls).toBe(0);

    const down = new OllamaProvider({ baseUrl: "http://ollama.example", model: "configured-model", fetch: fetchMock });
    expect((await down.health()).state).toBe("unreachable");
    expect(calls).toBe(1);
  });
});
