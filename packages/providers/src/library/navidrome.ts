import { createHash, randomBytes } from "node:crypto";
import { CONFIGURED_UNVERIFIED_MESSAGE, NAVIDROME_NOT_CONFIGURED, type VerifyStatus } from "@subwave-ai/shared";
import { defaultFetch, joinUrl, NotConfiguredError, ProviderHttpError, readJson, type FetchLike, type ProviderHealth } from "../http.js";
import { providerId } from "../ids.js";
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
  id?: unknown;
  title?: string;
  artist?: string;
  album?: string;
  path?: string;
  suffix?: string;
};

type MusicFolder = {
  id: string;
  name?: string;
};

function asSong(raw: SubsonicSong): LibrarySong | null {
  const id = providerId(raw.id);
  if (!id) return null;
  return {
    id,
    title: raw.title ?? "",
    artist: raw.artist,
    album: raw.album,
    path: raw.path,
    suffix: raw.suffix,
  };
}

function asSongs(song: SubsonicSong | SubsonicSong[] | undefined): LibrarySong[] {
  const rows = song == null ? [] : Array.isArray(song) ? song : [song];
  const songs: LibrarySong[] = [];
  for (const row of rows) {
    const parsed = asSong(row);
    if (parsed) songs.push(parsed);
  }
  return songs;
}

/** `getMusicFolders` may return one object or an array. Folder ids are strings. */
function asMusicFolders(payload: Record<string, unknown>): MusicFolder[] {
  const wrapper = payload.musicFolders;
  if (!wrapper || typeof wrapper !== "object") return [];
  const raw = (wrapper as { musicFolder?: unknown }).musicFolder;
  const rows = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const folders: MusicFolder[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as { id?: unknown; name?: unknown };
    const id = providerId(item.id);
    if (!id) continue;
    const folder: MusicFolder = { id };
    if (typeof item.name === "string" && item.name.length > 0) folder.name = item.name;
    folders.push(folder);
  }
  return folders;
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
    this.verifyStatus = opts.verifyStatus ?? "unverified";
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

  private refuseUnverified(): void {
    if (this.verifyStatus !== "unverified") return;
    if (this.configured) throw new Error(CONFIGURED_UNVERIFIED_MESSAGE);
    throw new Error("unverified library adapter: live endpoints not called");
  }

  private async rest<T>(method: string, extra: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    this.assertConfigured();
    this.refuseUnverified();
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
    return asSongs(result.song);
  }

  async getSong(id: string): Promise<LibrarySong | null> {
    const payload = this.unwrap(await this.rest("getSong", { id: providerId(id) ?? String(id) }));
    const song = payload.song as SubsonicSong | undefined;
    return song ? asSong(song) : null;
  }

  /**
   * Subsonic `getMusicFolders`. Not used on the request path. Folder id `1`
   * arrives as a JSON number and is stored as the string `"1"`.
   */
  async getMusicFolders(): Promise<MusicFolder[]> {
    const payload = this.unwrap(await this.rest("getMusicFolders"));
    return asMusicFolders(payload);
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
      return {
        ok: false,
        verifyStatus: this.verifyStatus,
        detail: CONFIGURED_UNVERIFIED_MESSAGE,
        checked_at,
      };
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
