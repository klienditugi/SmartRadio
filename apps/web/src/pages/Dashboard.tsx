import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import { useAuth } from "../auth";
import type { DiskSnapshot, JobRow, ProviderRow, RequestRow } from "../types";

type Overview = {
  requests_by_status: Record<string, number>;
  jobs_by_status: Record<string, number>;
  recent_requests: RequestRow[];
  recent_jobs: JobRow[];
  providers: ProviderRow[];
  disk: { volumes: DiskSnapshot[]; ok: boolean };
  doctor: {
    ok: boolean;
    ollama: string;
    acquire_unavailable?: boolean;
    notes: string[];
    integrations?: {
      llm?: { state: string | null; detail?: string };
      library?: { state: string | null; detail?: string };
      radio?: { state: string | null; detail?: string };
    };
  };
};

export function DashboardPage() {
  const { user } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setData(await api<Overview>("/ops/overview"));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 4000);
    return () => clearInterval(id);
  }, []);

  async function probe() {
    await api("/admin/health-probe", { method: "POST" });
    await load();
  }

  async function scan() {
    await api("/admin/library/scan", { method: "POST" });
    await load();
  }

  async function refreshPlaylist() {
    await api("/admin/radio/refresh-playlist", { method: "POST" });
    await load();
  }

  const providers = data?.providers ?? [];
  const volumes = data?.disk.volumes ?? [];

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Station status</h1>
          <p className="lede">Integrations, queue pressure, and persistent storage. Ollama stays external.</p>
        </div>
        {user?.role === "admin" ? (
          <div className="row">
            <button className="btn" type="button" onClick={() => void probe()}>
              Enqueue health probe
            </button>
            <button className="btn" type="button" onClick={() => void scan()} title="Optional ops action. Happy path does not require SmartRadio to trigger Navidrome scans.">
              Navidrome scan (ops only)
            </button>
            <button className="btn" type="button" onClick={() => void refreshPlaylist()}>
              Refresh radio playlist
            </button>
          </div>
        ) : null}
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="grid stats">
        {Object.entries(data?.requests_by_status ?? {})
          .filter(([, n]) => n > 0)
          .map(([status, n]) => (
            <div className="card" key={status}>
              <div className="muted">{status}</div>
              <div className="stat">{n}</div>
            </div>
          ))}
        <div className="card">
          <div className="muted">Doctor</div>
          <div className="stat">{data?.doctor.ok ? "ok" : "check"}</div>
          {data?.doctor.acquire_unavailable ? <div className="muted">acquire_unavailable</div> : null}
        </div>
      </div>
      <div className="grid two" style={{ marginTop: "1rem" }}>
        <div className="card">
          <h2>Providers</h2>
          {providers.map((p) => {
            let health: { ok?: boolean; detail?: string; state?: string } = {};
            try {
              health = p.last_health_json ? JSON.parse(p.last_health_json) : {};
            } catch {
              health = {};
            }
            const integration = data?.doctor.integrations?.[p.kind as "llm" | "library" | "radio"];
            const reported = health.state ?? integration?.state ?? undefined;
            const connection = reported === "not_configured" || reported === "unreachable" ? reported : undefined;
            return (
              <div key={p.id} className="row" style={{ justifyContent: "space-between", marginBottom: "0.6rem" }}>
                <div>
                  <strong>{p.name}</strong>
                  <div className="muted">
                    {p.kind} · <StatusBadge value={p.verify_status} />
                  </div>
                </div>
                {connection ? (
                  <StatusBadge value={connection} />
                ) : (
                  <span className={`health-dot ${health.ok ? "ok" : "bad"}`} title={health.detail ?? integration?.detail ?? "no probe yet"} />
                )}
              </div>
            );
          })}
          <p className="muted">Live probes run in the worker (`health_probe`). Last result is stored on the provider row.</p>
        </div>
        <div className="card">
          <h2>Persistent volumes</h2>
          {volumes.map((vol) => (
            <div key={vol.role} style={{ marginBottom: "0.7rem" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{vol.role}</strong>
                <StatusBadge value={vol.ok ? "ok" : "error"} />
              </div>
              <div className="muted">{vol.path}</div>
              {vol.used_ratio !== undefined ? (
                <div className="progress" style={{ marginTop: "0.35rem" }}>
                  <span style={{ width: `${Math.min(100, vol.used_ratio * 100)}%` }} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <div className="card" style={{ marginTop: "1rem" }}>
        <h2>Recent requests</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Query</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recent_requests ?? []).map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link to={`/requests/${row.id}`}>{row.raw_query}</Link>
                  </td>
                  <td>
                    <StatusBadge value={row.status} />
                  </td>
                  <td className="muted">{new Date(row.updated_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
