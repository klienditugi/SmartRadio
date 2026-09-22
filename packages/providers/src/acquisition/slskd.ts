import type { VerifyStatus } from "@subwave-ai/shared";
import { defaultFetch, joinUrl, readJson, type FetchLike, type ProviderHealth } from "../http.js";
import type { AcquisitionProvider } from "../types.js";

export type SoulseekProviderOptions = {
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
  verifyStatus?: VerifyStatus;
};

function apiRoot(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/api/v0") ? trimmed : `${trimmed}/api/v0`;
}

/** slskd-only acquisition. Other Soulseek frontends stay unverified. */
export class SoulseekProvider implements AcquisitionProvider {
  readonly kind = "slskd" as const;
  readonly verifyStatus: VerifyStatus;
  private readonly root: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: SoulseekProviderOptions) {
    this.root = apiRoot(opts.baseUrl);
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? defaultFetch();
    this.verifyStatus = opts.verifyStatus ?? "verified";
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "X-API-Key": this.apiKey,
    };
  }

  private assertVerified(): void {
    if (this.verifyStatus === "unverified") {
      throw new Error("unverified acquisition adapter: live endpoints not called");
    }
  }

  async search(searchText: string, id: string): Promise<unknown> {
    this.assertVerified();
    const res = await this.fetchImpl(joinUrl(this.root, "/searches"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ id, searchText }),
    });
    return readJson(res);
  }

  async getSearch(id: string, opts?: { includeResponses?: boolean }): Promise<unknown> {
    this.assertVerified();
    const include = opts?.includeResponses !== false;
    const path = `/searches/${encodeURIComponent(id)}${include ? "?includeResponses=true" : ""}`;
    const res = await this.fetchImpl(joinUrl(this.root, path), {
      method: "GET",
      headers: this.headers(),
    });
    return readJson(res);
  }

  async getSearchResponses(id: string): Promise<unknown> {
    this.assertVerified();
    const res = await this.fetchImpl(joinUrl(this.root, `/searches/${encodeURIComponent(id)}/responses`), {
      method: "GET",
      headers: this.headers(),
    });
    return readJson(res);
  }

  async enqueueDownload(user: string, files: unknown): Promise<unknown> {
    this.assertVerified();
    const res = await this.fetchImpl(joinUrl(this.root, `/transfers/downloads/${encodeURIComponent(user)}`), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(files),
    });
    if (res.status === 204 || res.status === 201) {
      return { ok: true, status: res.status };
    }
    return readJson(res);
  }

  async listDownloads(): Promise<unknown> {
    this.assertVerified();
    const res = await this.fetchImpl(joinUrl(this.root, "/transfers/downloads"), {
      method: "GET",
      headers: this.headers(),
    });
    return readJson(res);
  }

  async health(): Promise<ProviderHealth> {
    const checked_at = new Date().toISOString();
    if (this.verifyStatus === "unverified") {
      return { ok: false, verifyStatus: this.verifyStatus, detail: "unverified adapter; not calling live endpoints", checked_at };
    }
    try {
      const appRes = await this.fetchImpl(joinUrl(this.root, "/application"), {
        method: "GET",
        headers: this.headers(),
      });
      await readJson(appRes);
      const serverRes = await this.fetchImpl(joinUrl(this.root, "/server"), {
        method: "GET",
        headers: this.headers(),
      });
      const server = (await readJson(serverRes)) as { isConnected?: boolean; IsConnected?: boolean };
      const loggedIn = server.isConnected === true || server.IsConnected === true;
      return {
        ok: loggedIn,
        verifyStatus: this.verifyStatus,
        detail: loggedIn
          ? "GET /api/v0/application + GET /api/v0/server (connected)"
          : "GET /api/v0/server reports not connected",
        checked_at,
      };
    } catch (err) {
      return { ok: false, verifyStatus: this.verifyStatus, detail: (err as Error).message, checked_at };
    }
  }
}
