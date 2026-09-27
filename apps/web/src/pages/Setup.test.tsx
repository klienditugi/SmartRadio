import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth";
import { SetupPage } from "./Setup";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Setup env pins", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows an env-pinned model as read-only and does not submit it", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        if (url.endsWith("/setup") && method === "GET") {
          return json({
            configured: false,
            setup_complete: false,
            missing: [],
            ollama: "external-only",
            secrets_present: {},
            sources: { "llm.model": { source: "env", env: "OLLAMA_MODEL" } },
          });
        }
        if (url.endsWith("/auth/me")) return json({ error: "unauthorized" }, 401);
        if (url.endsWith("/setup") && method === "POST") return json({ ok: true, setup: { configured: true, missing: [] } });
        return json({ error: `unexpected ${method} ${url}` }, 500);
      }),
    );

    render(
      <MemoryRouter>
        <AuthProvider>
          <SetupPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Admin username")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const model = screen.getByText("Model name (no default)").closest("label")?.querySelector("input") as HTMLInputElement;
    expect(model.readOnly).toBe(true);
    expect(screen.getByText("set by OLLAMA_MODEL in .env")).toBeTruthy();
    fireEvent.change(model, { target: { value: "should-not-stick" } });
    for (let step = 0; step < 4; step++) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST")).toBe(true);
    });
    const post = calls.find((call) => call.method === "POST");
    const config = (post?.body as { config?: { llm?: { model?: string } } } | undefined)?.config;
    expect(config?.llm?.model).toBeUndefined();
    expect(JSON.stringify(post?.body)).not.toContain("should-not-stick");
  });
});
