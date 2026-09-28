import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationProbe } from "./IntegrationProbe";

const LEAKED = "should-never-render";

type Call = { url: string; method: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("IntegrationProbe", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows configured_unverified and posts test-connection without sending secrets", async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.endsWith("/llm/status") && method === "GET") {
          return json({
            ok: false,
            state: "configured_unverified",
            probed: false,
            detail: "configured but unverified, run test connection",
            settings: {
              base_url: "http://ollama.example",
              model: "station-model",
              verify_status: "unverified",
              password: LEAKED,
            },
          });
        }
        if (url.endsWith("/llm/test-connection") && method === "POST") {
          return json({
            ok: true,
            state: "ready",
            probed: true,
            detail: "GET /api/tags includes the configured model",
            settings: { base_url: "http://ollama.example", model: "station-model", verify_status: "verified" },
          });
        }
        return json({ error: `unexpected ${method} ${url}` }, 500);
      }),
    );

    render(<IntegrationProbe kind="llm" />);
    expect((await screen.findByRole("status")).textContent).toContain("Configured, unverified");
    expect(screen.getByText(/configured but unverified, run test connection/)).toBeTruthy();
    expect(screen.getByText(/saved verification: unverified/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(LEAKED);
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Ready");
    });
    expect(screen.getByText(/GET \/api\/tags includes the configured model/)).toBeTruthy();
    expect(screen.getByText(/saved verification: verified/)).toBeTruthy();
    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toContain("/api/v1/llm/test-connection");
    expect(calls.some((call) => call.url.includes("/api/pull") || call.url.includes("/dj/say"))).toBe(false);
    expect(document.body.textContent).not.toContain(LEAKED);
  });
});
