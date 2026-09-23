import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcquisitionForm } from "./AcquisitionForm";

const LEAKED = "should-never-render";

type Call = { url: string; method: string; body?: Record<string, unknown> };

const settings = {
  enabled: true,
  provider: "slskd",
  base_url: "http://slskd.example:5030",
  downloads: "/var/lib/station/downloads",
  library: "/var/lib/station/library",
  api_key_configured: true,
  verify_status: "unverified",
  supported_providers: ["slskd"],
  api_key: LEAKED,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(calls: Call[], statusState = "not_configured", provider = "slskd") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith("/acquisition/settings") && method === "GET") return json({ ...settings, provider });
      if (url.endsWith("/acquisition/status") && method === "GET") {
        return json({
          state: statusState,
          verify_status: "unverified",
          detail: "live probe, not merely filled fields",
          checked_at: "2026-01-01T00:00:00.000Z",
          api_key_configured: true,
        });
      }
      if (url.endsWith("/acquisition/settings") && method === "PUT") {
        return json({
          ...settings,
          enabled: body?.enabled,
          provider: body?.provider,
          base_url: body?.base_url,
          downloads: body?.downloads,
          library: body?.library,
          api_key_configured: Boolean(body?.api_key) || settings.api_key_configured,
          verify_status: "unverified",
        });
      }
      if (url.endsWith("/acquisition/test-connection") && method === "POST") {
        return json({
          state: "ready",
          verify_status: "verified",
          detail: "GET /api/v0/application + GET /api/v0/server",
          checked_at: "2026-01-01T00:00:00.000Z",
          api_key_configured: true,
          worker_reload_required: true,
        });
      }
      return json({ error: `unexpected ${method} ${url}` }, 500);
    }),
  );
}

describe("AcquisitionForm", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the enabled provider form and a write-only key", async () => {
    const calls: Call[] = [];
    installFetch(calls);
    render(<AcquisitionForm mode="settings" />);
    expect((await screen.findByRole("status")).textContent).toContain("Not configured");
    const enabled = screen.getByRole("checkbox", { name: "Acquisition enabled" }) as HTMLInputElement;
    expect(enabled.checked).toBe(true);
    expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("slskd");
    expect((screen.getByLabelText("slskd URL") as HTMLInputElement).value).toBe("http://slskd.example:5030");
    const key = screen.getByLabelText("slskd API key") as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.value).toBe("");
    expect(screen.getByText("Configured")).toBeTruthy();
    expect(document.body.textContent).not.toContain(LEAKED);
    fireEvent.click(enabled);
    fireEvent.click(screen.getByRole("button", { name: "Save acquisition" }));
    await screen.findByText(/Saved\. A filled-in form is not a connection/);
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.body).toMatchObject({ enabled: false, provider: "slskd" });
    expect(put?.body).not.toHaveProperty("api_key");
    expect(calls.some((call) => /searches|transfers/.test(call.url))).toBe(false);
  });

  it("keeps an unknown provider selectable and can switch to slskd", async () => {
    const calls: Call[] = [];
    installFetch(calls, "not_configured", "future-daemon");
    render(<AcquisitionForm mode="settings" />);
    const select = (await screen.findByLabelText("Provider")) as HTMLSelectElement;
    expect(select.value).toBe("future-daemon");
    fireEvent.change(select, { target: { value: "slskd" } });
    fireEvent.click(screen.getByRole("button", { name: "Save acquisition" }));
    await screen.findByText(/Saved\. A filled-in form is not a connection/);
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.body?.provider).toBe("slskd");
  });

  it("sends a newly typed API key on test connection and shows the live result", async () => {
    const calls: Call[] = [];
    installFetch(calls);
    render(<AcquisitionForm mode="settings" />);
    const key = (await screen.findByLabelText("slskd API key")) as HTMLInputElement;
    fireEvent.change(key, { target: { value: "replacement-api-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Ready");
    });
    expect(screen.getByText(/GET \/api\/v0\/application \+ GET \/api\/v0\/server/)).toBeTruthy();
    const put = calls.find((call) => call.method === "PUT");
    const post = calls.find((call) => call.method === "POST");
    expect(put?.url).toContain("/api/v1/acquisition/settings");
    expect(put?.body?.api_key).toBe("replacement-api-key");
    expect(post?.url).toContain("/api/v1/acquisition/test-connection");
    expect(calls.map((call) => call.url).every((url) => url.includes("/api/v1/acquisition/"))).toBe(true);
    expect((screen.getByLabelText("slskd API key") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain(LEAKED);
  });
});
