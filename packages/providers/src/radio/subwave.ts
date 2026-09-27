import { SUBWAVE_RADIO_NOT_CONFIGURED, type VerifyStatus } from "@subwave-ai/shared";
import { defaultFetch, joinUrl, NotConfiguredError, ProviderHttpError, readJson, type FetchLike, type ProviderHealth } from "../http.js";
import { SAY_TEXT_MAX_CHARS, type RadioProvider, type SayKind, type SayRequest, type SayResult } from "../types.js";

export type SubWaveProviderOptions = {
  /** Opaque. Production may already include `/api`. */
  baseUrl: string;
  adminUser: string;
  adminPassword: string;
  fetch?: FetchLike;
  verifyStatus?: VerifyStatus;
};

/** HTTP 409 from `POST /dj/queue-track` — station never-play, not a transient error. */
export class NeverPlayError extends Error {
  readonly status = 409;
  readonly body?: string;

  constructor(body?: string) {
    super("never-play");
    this.name = "NeverPlayError";
    this.body = body;
  }
}

function clampSayText(text: string): string {
  if (typeof text !== "string") {
    throw new Error("say text is required");
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("say text is required");
  }
  const chars = Array.from(trimmed);
  if (chars.length <= SAY_TEXT_MAX_CHARS) return trimmed;
  return chars.slice(0, SAY_TEXT_MAX_CHARS).join("");
}

function resolveSayKind(kind: SayKind | undefined): SayKind {
  if (kind === undefined) return "dj-speak";
  if (kind === "dj-speak" || kind === "link") return kind;
  throw new Error(`unsupported say kind: ${kind}`);
}

function parseSayResult(body: unknown): SayResult {
  if (!body || typeof body !== "object") {
    throw new Error("invalid /dj/say response");
  }
  const row = body as Record<string, unknown>;
  if (row.ok !== true || typeof row.mode !== "string" || typeof row.kind !== "string" || typeof row.spoken !== "string") {
    throw new Error("invalid /dj/say response");
  }
  const result: SayResult = {
    ok: true,
    mode: row.mode,
    kind: row.kind,
    spoken: row.spoken,
  };
  if ("sfx" in row) result.sfx = row.sfx;
  return result;
}

export class SubWaveProvider implements RadioProvider {
  readonly kind = "subwave" as const;
  readonly verifyStatus: VerifyStatus;
  private readonly configured: boolean;
  private readonly baseUrl: string;
  private readonly adminUser: string;
  private readonly adminPassword: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: SubWaveProviderOptions) {
    this.baseUrl = opts.baseUrl.trim().replace(/\/+$/, "");
    this.adminUser = opts.adminUser.trim();
    this.adminPassword = opts.adminPassword;
    this.configured = Boolean(this.baseUrl && this.adminUser && opts.adminPassword.trim());
    this.fetchImpl = opts.fetch ?? defaultFetch();
    this.verifyStatus = opts.verifyStatus ?? "verified";
  }

  private assertConfigured(): void {
    if (!this.configured) throw new NotConfiguredError(SUBWAVE_RADIO_NOT_CONFIGURED);
  }

  private basicAuth(): string {
    return `Basic ${Buffer.from(`${this.adminUser}:${this.adminPassword}`).toString("base64")}`;
  }

  private async getPublic(pathname: string): Promise<unknown> {
    this.assertConfigured();
    if (this.verifyStatus === "unverified") {
      throw new Error("unverified radio adapter: live endpoints not called");
    }
    const res = await this.fetchImpl(joinUrl(this.baseUrl, pathname), { method: "GET" });
    return readJson(res);
  }

  async health(): Promise<ProviderHealth> {
    const checked_at = new Date().toISOString();
    if (!this.configured) {
      return {
        ok: false,
        state: "not_configured",
        verifyStatus: this.verifyStatus,
        detail: SUBWAVE_RADIO_NOT_CONFIGURED,
        checked_at,
      };
    }
    if (this.verifyStatus === "unverified") {
      return { ok: false, verifyStatus: this.verifyStatus, detail: "unverified adapter; not calling live endpoints", checked_at };
    }
    try {
      await this.getPublic("/health");
      return { ok: true, state: "reachable", verifyStatus: this.verifyStatus, detail: "GET /health", checked_at };
    } catch (err) {
      if (err instanceof NotConfiguredError) {
        return { ok: false, state: "not_configured", verifyStatus: this.verifyStatus, detail: err.message, checked_at };
      }
      if (err instanceof ProviderHttpError) {
        return { ok: false, state: "reachable", verifyStatus: this.verifyStatus, detail: err.message, checked_at };
      }
      return { ok: false, state: "unreachable", verifyStatus: this.verifyStatus, detail: (err as Error).message, checked_at };
    }
  }

  nowPlaying(): Promise<unknown> {
    return this.getPublic("/now-playing");
  }

  state(): Promise<unknown> {
    return this.getPublic("/state");
  }

  async djSearch(query: string, opts?: { limit?: number; offset?: number }): Promise<unknown> {
    this.assertConfigured();
    if (this.verifyStatus === "unverified") {
      throw new Error("unverified radio adapter: live endpoints not called");
    }
    const url = new URL(joinUrl(this.baseUrl, "/dj/search"));
    url.searchParams.set("q", query);
    if (opts?.limit !== undefined) url.searchParams.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) url.searchParams.set("offset", String(opts.offset));
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { authorization: this.basicAuth() },
    });
    return readJson(res);
  }

  async queueTrack(track: { id: string; title: string; artist?: string; album?: string }): Promise<unknown> {
    this.assertConfigured();
    if (this.verifyStatus === "unverified") {
      throw new Error("unverified radio adapter: live endpoints not called");
    }
    const payload: { id: string; title: string; artist?: string; album?: string } = {
      id: track.id,
      title: track.title,
    };
    if (track.artist !== undefined) payload.artist = track.artist;
    if (track.album !== undefined) payload.album = track.album;
    const res = await this.fetchImpl(joinUrl(this.baseUrl, "/dj/queue-track"), {
      method: "POST",
      headers: {
        authorization: this.basicAuth(),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 409) {
      throw new NeverPlayError(await res.text());
    }
    return readJson(res);
  }

  async say(input: SayRequest): Promise<SayResult> {
    this.assertConfigured();
    if (this.verifyStatus === "unverified") {
      throw new Error("unverified radio adapter: live endpoints not called");
    }
    const text = clampSayText(input.text);
    const kind = resolveSayKind(input.kind);
    const payload: { text: string; mode: "styled"; kind: SayKind; sfx?: unknown } = {
      text,
      mode: "styled",
      kind,
    };
    if (input.sfx !== undefined) payload.sfx = input.sfx;
    const res = await this.fetchImpl(joinUrl(this.baseUrl, "/dj/say"), {
      method: "POST",
      headers: {
        authorization: this.basicAuth(),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return parseSayResult(await readJson<unknown>(res));
  }

  async refreshPlaylist(): Promise<unknown> {
    this.assertConfigured();
    if (this.verifyStatus === "unverified") {
      throw new Error("unverified radio adapter: live endpoints not called");
    }
    const res = await this.fetchImpl(joinUrl(this.baseUrl, "/dj/refresh-playlist"), {
      method: "POST",
      headers: { authorization: this.basicAuth() },
    });
    return readJson(res);
  }

  async publicRequest(body: { text: string; name?: string }): Promise<unknown> {
    this.assertConfigured();
    if (this.verifyStatus === "unverified") {
      throw new Error("unverified radio adapter: live endpoints not called");
    }
    const res = await this.fetchImpl(joinUrl(this.baseUrl, "/request"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body.text, name: body.name ?? "" }),
    });
    return readJson(res);
  }

  async publicRequestStatus(id: string): Promise<unknown> {
    return this.getPublic(`/request/${encodeURIComponent(id)}`);
  }
}
