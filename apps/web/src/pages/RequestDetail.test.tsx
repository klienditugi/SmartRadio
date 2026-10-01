import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../auth";
import { setToken } from "../api";
import { RequestDetailPage } from "./RequestDetail";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const detail = {
  request: {
    id: "req-1",
    user_id: null,
    raw_query: "Artist - Title",
    artist: "Artist",
    title: "Title",
    genre: null,
    status: "DOWNLOADING",
    classification_json: null,
    policy_json: null,
    error: "raw-error-stays",
    created_at: 1,
    updated_at: 1,
  },
  events: [],
  jobs: [],
  acquisitions: [
    {
      id: "acq-1",
      request_id: "req-1",
      remote_user: "hidden-peer",
      filename: "hidden-acquire.flac",
      status: "InProgress",
      progress: 0.4,
      created_at: 1,
      updated_at: 1,
    },
  ],
  matches: [],
  llm_calls: [],
};

function stubFetch(role: "admin" | "operator" | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/setup")) {
        return json({
          configured: true,
          setup_complete: true,
          missing: [],
          ollama: "external-only",
          secrets_present: {},
        });
      }
      if (url.endsWith("/auth/me")) {
        if (!role) return json({ error: "unauthorized" }, 401);
        return json({ user: { id: "user-1", username: role, role } });
      }
      if (url.includes("/requests/req-1")) return json(detail);
      return json({ error: `unexpected ${url}` }, 500);
    }),
  );
}

function renderDetail() {
  render(
    <MemoryRouter initialEntries={["/requests/req-1"]}>
      <AuthProvider>
        <Routes>
          <Route path="/requests/:id" element={<RequestDetailPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("RequestDetail acquisition fields", () => {
  afterEach(() => {
    cleanup();
    setToken(null);
    vi.unstubAllGlobals();
  });

  it("hides the acquisition filename and remote user from non-admins", async () => {
    setToken("operator-token");
    stubFetch("operator");
    renderDetail();
    expect(await screen.findByText("raw-error-stays")).toBeTruthy();
    expect(screen.getByText("InProgress")).toBeTruthy();
    expect(screen.getByText("DOWNLOADING")).toBeTruthy();
    expect(screen.queryByText("hidden-peer")).toBeNull();
    expect(screen.queryByText("hidden-acquire.flac")).toBeNull();
    expect(screen.queryByText("transfer")).toBeNull();
  });

  it("shows the acquisition filename and remote user to an admin", async () => {
    setToken("admin-token");
    stubFetch("admin");
    renderDetail();
    expect(await screen.findByText(/hidden-acquire\.flac/)).toBeTruthy();
    expect(screen.getByText(/hidden-peer/)).toBeTruthy();
    expect(screen.getByText("raw-error-stays")).toBeTruthy();
    const progress = screen.getByRole("heading", { name: "Download progress" }).parentElement;
    expect(progress?.textContent).toContain("InProgress");
    expect(progress?.textContent).toContain("hidden-acquire.flac");
    expect(progress?.textContent).toContain("hidden-peer");
  });
});
