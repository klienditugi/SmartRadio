import type { VerifyStatus } from "@subwave-ai/shared";
import { defaultFetch, joinUrl, readJson, type FetchLike, type ProviderHealth } from "../http.js";
import type { RadioProvider } from "../types.js";

export type SubWaveProviderOptions = {
  /** Opaque. Production may already include `/api`. */
  baseUrl: string;
  adminUser: string;
  adminPassword: string;
  fetch?: FetchLike;
  verifyStatus?: VerifyStatus;
};

export class SubWaveProvider implements RadioProvider {
  readonly kind = "subwave" as const;
  readonly verifyStatus: VerifyStatus;
  private readonly baseUrl: string;
  private readonly adminUser: string;
  private readonly adminPassword: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: SubWaveProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.adminUser = opts.adminUser;
    this.adminPassword = opts.adminPassword;
    this.fetchImpl = opts.fetch ?? defaultFetch();
    this.verifyStatus = opts.verifyStatus ?? "verified";
  }

  private basicAuth(): string {
    return `Basic ${Buffer.from(`${this.adminUser}:${this.adminPassword}`).toString("base64")}`;
  }

  private async getPublic(pathname: string): Promise<unknown> {
    if (this.verifyStatus === "unverified") {
      throw new Error("unverified radio adapter: live endpoints not called");
    }
    const res = await this.fetchImpl(joinUrl(this.baseUrl, pathname), { method: "GET" });
    return readJson(res);
  }

  async health(): Promise<ProviderHealth> {
    const checked_at = new Date().toISOString();
    if (this.verifyStatus === "unverified") {
      return { ok: false, verifyStatus: this.verifyStatus, detail: "unverified adapter; not calling live endpoints", checked_at };
    }
    try {
      await this.getPublic("/health");
      return { ok: true, verifyStatus: this.verifyStatus, detail: "GET /health", checked_at };
    } catch (err) {
      return { ok: false, verifyStatus: this.verifyStatus, detail: (err as Error).message, checked_at };
    }
  }

  nowPlaying(): Promise<unknown> {
    return this.getPublic("/now-playing");
  }

  state(): Promise<unknown> {
    return this.getPublic("/state");
  }

  async djSearch(query: string, opts?: { limit?: number; offset?: number }): Promise<unknown> {
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

  async queueTrack(track: { id: string; title: string; artist?: string }): Promise<unknown> {
    if (this.verifyStatus === "unverified") {
      throw new Error("unverified radio adapter: live endpoints not called");
    }
    const res = await this.fetchImpl(joinUrl(this.baseUrl, "/dj/queue-track"), {
      method: "POST",
      headers: {
        authorization: this.basicAuth(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: track.id, title: track.title, artist: track.artist }),
    });
    return readJson(res);
  }

  async refreshPlaylist(): Promise<unknown> {
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
