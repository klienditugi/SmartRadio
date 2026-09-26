import {
  CLASSIFICATION_JSON_SCHEMA,
  parseClassificationJson,
  type Classification,
  type VerifyStatus,
} from "@subwave-ai/shared";
import { defaultFetch, joinUrl, readJson, type FetchLike, type ProviderHealth } from "../http.js";
import type { LLMProvider } from "../types.js";

export type OllamaProviderOptions = {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  verifyStatus?: VerifyStatus;
};

const CLASSIFY_SYSTEM =
  "You classify music requests for a radio station. Return JSON only matching the provided schema. " +
  "Do not run tools, shell commands, or file/config changes. Classification is descriptive only; " +
  "station policy is applied elsewhere.";

export class OllamaProvider implements LLMProvider {
  readonly kind = "ollama" as const;
  readonly verifyStatus: VerifyStatus;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OllamaProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetch ?? defaultFetch();
    this.verifyStatus = opts.verifyStatus ?? "unverified";
  }

  async classify(input: { text: string; model?: string }): Promise<Classification> {
    if (this.verifyStatus === "unverified") {
      throw new Error("unverified LLM adapter: live endpoints not called");
    }
    const model = input.model ?? this.model;
    if (!model) {
      throw new Error("LLM model is not configured (refusing to hard-code a model name)");
    }
    const body = {
      model,
      stream: false,
      format: CLASSIFICATION_JSON_SCHEMA,
      options: { temperature: 0 },
      messages: [
        { role: "system", content: CLASSIFY_SYSTEM },
        { role: "user", content: input.text },
      ],
    };
    const res = await this.fetchImpl(joinUrl(this.baseUrl, "/api/chat"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = await readJson<{ message?: { content?: string }; content?: string }>(res);
    const raw = json.message?.content ?? json.content ?? "";
    return parseClassificationJson(raw);
  }

  async health(): Promise<ProviderHealth> {
    const checked_at = new Date().toISOString();
    if (this.verifyStatus === "unverified") {
      return { ok: false, verifyStatus: this.verifyStatus, detail: "unverified adapter; not calling live endpoints", checked_at };
    }
    try {
      const version = await this.fetchImpl(joinUrl(this.baseUrl, "/api/version"), {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      if (version.ok) {
        return { ok: true, verifyStatus: this.verifyStatus, detail: "GET /api/version", checked_at };
      }
      const tags = await this.fetchImpl(joinUrl(this.baseUrl, "/api/tags"), {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      return {
        ok: tags.ok,
        verifyStatus: this.verifyStatus,
        detail: tags.ok ? "GET /api/tags" : `health failed HTTP ${tags.status}`,
        checked_at,
      };
    } catch (err) {
      return { ok: false, verifyStatus: this.verifyStatus, detail: (err as Error).message, checked_at };
    }
  }
}
