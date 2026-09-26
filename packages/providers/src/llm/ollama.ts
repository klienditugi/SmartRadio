import {
  CLASSIFICATION_JSON_SCHEMA,
  CONFIGURED_UNVERIFIED_MESSAGE,
  ollamaNotConfiguredDetail,
  parseClassificationJson,
  type Classification,
  type VerifyStatus,
} from "@subwave-ai/shared";
import { defaultFetch, joinUrl, NotConfiguredError, ProviderHttpError, readJson, type FetchLike, type ProviderHealth } from "../http.js";
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

  private readonly configured: boolean;

  constructor(opts: OllamaProviderOptions) {
    this.baseUrl = opts.baseUrl.trim().replace(/\/+$/, "");
    this.model = opts.model.trim();
    this.configured = Boolean(this.baseUrl && this.model);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetch ?? defaultFetch();
    this.verifyStatus = opts.verifyStatus ?? "unverified";
  }

  private refuseUnverified(): void {
    if (this.verifyStatus !== "unverified") return;
    if (this.configured) throw new Error(CONFIGURED_UNVERIFIED_MESSAGE);
    throw new Error("unverified LLM adapter: live endpoints not called");
  }

  private assertConfigured(model: string): void {
    if (!this.baseUrl || !model.trim()) {
      throw new NotConfiguredError(ollamaNotConfiguredDetail({ baseUrl: this.baseUrl, model }));
    }
  }

  async classify(input: { text: string; model?: string }): Promise<Classification> {
    const model = (input.model ?? this.model).trim();
    this.assertConfigured(model);
    this.refuseUnverified();
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
    if (!this.configured) {
      return {
        ok: false,
        state: "not_configured",
        verifyStatus: this.verifyStatus,
        detail: ollamaNotConfiguredDetail({ baseUrl: this.baseUrl, model: this.model }),
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
      const version = await this.fetchImpl(joinUrl(this.baseUrl, "/api/version"), {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      if (version.ok) {
        return { ok: true, state: "reachable", verifyStatus: this.verifyStatus, detail: "GET /api/version", checked_at };
      }
      const tags = await this.fetchImpl(joinUrl(this.baseUrl, "/api/tags"), {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      return {
        ok: tags.ok,
        state: "reachable",
        verifyStatus: this.verifyStatus,
        detail: tags.ok ? "GET /api/tags" : `health failed HTTP ${tags.status}`,
        checked_at,
      };
    } catch (err) {
      if (err instanceof ProviderHttpError) {
        return { ok: false, state: "reachable", verifyStatus: this.verifyStatus, detail: err.message, checked_at };
      }
      return { ok: false, state: "unreachable", verifyStatus: this.verifyStatus, detail: (err as Error).message, checked_at };
    }
  }
}
