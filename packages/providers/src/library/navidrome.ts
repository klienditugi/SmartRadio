import { createHash, randomBytes } from "node:crypto";
import { NAVIDROME_NOT_CONFIGURED, type VerifyStatus } from "@subwave-ai/shared";
import { defaultFetch, joinUrl, NotConfiguredError, ProviderHttpError, readJson, type FetchLike, type ProviderHealth } from "../http.js";
import type { LibrarySong, MusicLibraryProvider } from "../types.js";

export type NavidromeProviderOptions = {
  baseUrl: string;
  username: string;
  password: string;
  clientName?: string;
  apiVersion?: string;
  fetch?: FetchLike;
  verifyStatus?: VerifyStatus;
};

type SubsonicSong = {
  id: string | number;
  title?: string;
  artist?: string;
  album?: string;
  path?: string;
  suffix?: string;
};

function asSong(raw: SubsonicSong): LibrarySong {
  return {
    id: String(raw.id),
    title: raw.title ?? "",
    artist: raw.artist,
    album: raw.album,
    path: raw.path,
    suffix: raw.suffix,
  };
}

export class NavidromeProvider implements MusicLibraryProvider {
  readonly kind = "navidrome" as const;
  readonly verifyStatus: VerifyStatus;
  private readonly configured: boolean;
  private readonly restBase: string;
  private readonly username: string;
  private readonly password: string;
  private readonly clientName: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: NavidromeProviderOptions) {
    const trimmed = opts.baseUrl.trim().replace(/\/+$/, "");
    this.username = opts.username.trim();
    this.password = opts.password;
    this.configured = Boolean(trimmed && this.username && opts.password.trim());
    this.restBase = trimmed.endsWith("/rest") ? trimmed : `${trimmed}/rest`;
    this.clientName = opts.clientName ?? "subwave-ai";
    this.apiVersion = opts.apiVersion ?? "1.16.1";
    this.fetchImpl = opts.fetch ?? defaultFetch();
    this.verifyStatus = opts.verifyStatus ?? "verified";
  }

  private assertConfigured(): void {
    if (!this.configured) throw new NotConfiguredError(NAVIDROME_NOT_CONFIGURED);
  }

  private authParams(): Record<string, string> {
    const salt = randomBytes(8).toString("hex");
    const token = createHash("md5").update(`${this.password}${salt}`).digest("hex");
    return {
      u: this.username,
      t: token,
      s: salt,
      v: this.apiVersion,
      c: this.clientName,
      f: "json",
    };
  }

  private async rest<T>(method: string, extra: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    this.assertConfigured();
    if (this.verifyStatus === "unverified") {
      throw new Error("unverified library adapter: live endpoints not called");
    }
    const url = new URL(joinUrl(this.restBase, method));
    for (const [k, v] of Object.entries({ ...this.authParams(), ...extra })) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
    const res = await this.fetchImpl(url, { method: "GET" });
    return readJson<T>(res);
  }

  private unwrap(payload: Record<string, unknown>): Record<string, unknown> {
    const inner = (payload["subsonic-response"] ?? payload) as Record<string, unknown>;
    if (inner.status && inner.status !== "ok") {
      throw new Error(`navidrome error: ${JSON.stringify(inner.error ?? inner)}`);
    }
    return inner;
  }

  async search3(query: string, opts?: { songCount?: number; songOffset?: number }): Promise<LibrarySong[]> {
    const payload = this.unwrap(
      await this.rest("search3", {
        query,
        songCount: opts?.songCount ?? 20,
        songOffset: opts?.songOffset ?? 0,
        artistCount: 0,
        albumCount: 0,
      }),
    );
    const result = (payload.searchResult3 ?? {}) as { song?: SubsonicSong | SubsonicSong[] };
    const songs = result.song ?? [];
    return (Array.isArray(songs) ? songs : [songs]).map(asSong);
  }

  async getSong(id: string): Promise<LibrarySong | null> {
    const payload = this.unwrap(await this.rest("getSong", { id: String(id) }));
    const song = payload.song as SubsonicSong | undefined;
    return song ? asSong(song) : null;
  }

  /** Ops-only index trigger. A3 happy path relies on Navidrome’s own ~1min scanner. */
  async startScan(opts?: { fullScan?: boolean }): Promise<unknown> {
    return this.unwrap(await this.rest("startScan", { fullScan: opts?.fullScan }));
  }

  async getScanStatus(): Promise<unknown> {
    return this.unwrap(await this.rest("getScanStatus"));
  }

  async health(): Promise<ProviderHealth> {
    const checked_at = new Date().toISOString();
    if (!this.configured) {
      return {
        ok: false,
        state: "not_configured",
        verifyStatus: this.verifyStatus,
        detail: NAVIDROME_NOT_CONFIGURED,
        checked_at,
      };
    }
    if (this.verifyStatus === "unverified") {
      return { ok: false, verifyStatus: this.verifyStatus, detail: "unverified adapter; not calling live endpoints", checked_at };
    }
    try {
      await this.getScanStatus();
      return { ok: true, state: "reachable", verifyStatus: this.verifyStatus, detail: "GET /rest/getScanStatus", checked_at };
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
}
