import type { VerifyStatus } from "@subwave-ai/shared";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ProviderHealth = {
  ok: boolean;
  verifyStatus: VerifyStatus;
  detail?: string;
  checked_at: string;
};

export function joinUrl(baseUrl: string, pathname: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const rel = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  return new URL(rel, base).toString();
}

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export class UnverifiedAdapterError extends Error {
  constructor(kind: string, detail: string) {
    super(`unverified ${kind} adapter: ${detail}`);
    this.name = "UnverifiedAdapterError";
  }
}

export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new ProviderHttpError(`HTTP ${res.status} ${res.url}`, res.status, text);
  }
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export function defaultFetch(): FetchLike {
  return globalThis.fetch.bind(globalThis);
}
