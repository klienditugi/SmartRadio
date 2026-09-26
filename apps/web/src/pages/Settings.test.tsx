import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth";
import { SettingsPage } from "./Settings";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const settings = {
  config: {
    llm: { base_url: "http://ollama.example", model: "pinned-model" },
    library: { base_url: "", username: "" },
    radio: { base_url: "", admin_user: "" },
    integrations: {
      llm: { state: "configured_unverified" },
      library: { state: "not_configured" },
      radio: { state: "not_configured" },
    },
    acquisition: { base_url: "http://slskd.example" },
    policy: {
      require_electronic: true,
      require_station_match: true,
      min_confidence: 0.5,
      allowed_genres: [],
      blocked_artists: [],
      blocked_terms: [],
    },
    secrets_present: {},
    paths: { library: "/library", downloads: "/downloads", staging: "/staging" },
  },
  settings: {},
  sources: { "llm.model": { source: "env", env: "OLLAMA_MODEL" } },
};

describe("Settings env pins", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("notes when the model is set by OLLAMA_MODEL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/setup") && method === "GET") {
          return json({ configured: true, setup_complete: true, missing: [], ollama: "external-only", secrets_present: {}, sources: settings.sources });
        }
        if (url.endsWith("/auth/me")) return json({ user: { id: "u", username: "admin", role: "admin" } });
        if (url.endsWith("/acquisition/settings")) {
          return json({
            enabled: false,
            provider: "slskd",
            base_url: "http://slskd.example",
            verify_status: "unverified",
            paths: { downloads: "/downloads", library: "/library" },
            secrets_present: { slskd_api_key: false },
          });
        }
        if (url.endsWith("/acquisition/status")) {
          return json({
            state: "disabled",
            detail: "acquisition is disabled",
            settings: {
              verify_status: "unverified",
              base_url: "http://slskd.example",
              enabled: false,
              provider: "slskd",
              paths: { downloads: "/downloads", library: "/library" },
              secrets_present: { slskd_api_key: false },
            },
          });
        }
        if (url.endsWith("/settings") && method === "GET") return json(settings);
        if (url.endsWith("/llm/status")) {
          return json({ state: "configured_unverified", detail: "configured but unverified, run test connection", settings: { verify_status: "unverified" } });
        }
        if (url.endsWith("/library/status") || url.endsWith("/radio/status")) {
          return json({ state: "not_configured", detail: "not configured", settings: { verify_status: "unverified" } });
        }
        return json({ error: `unexpected ${method} ${url}` }, 500);
      }),
    );

    render(
      <MemoryRouter>
        <AuthProvider>
          <SettingsPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("set by OLLAMA_MODEL in .env")).toBeTruthy();
    expect(screen.getByText(/pinned-model/)).toBeTruthy();
  });
});
