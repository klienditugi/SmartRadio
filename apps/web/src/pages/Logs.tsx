import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import type { AcquisitionRow, JobRow, RequestEventRow } from "../types";

type Logs = {
  events: RequestEventRow[];
  jobs: JobRow[];
  llm_calls: Array<{ id: string; model: string; error: string | null; parsed_ok: number; created_at: number; prompt: string }>;
  acquisitions: AcquisitionRow[];
};

export function LogsPage() {
  const [data, setData] = useState<Logs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api<Logs>("/ops/logs")
        .then(setData)
        .catch((err) => setError((err as Error).message));
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Errors and logs</h1>
          <p className="lede">Request events, failed jobs, LLM parse errors, and acquisition snapshots from SQLite.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="grid two">
        <div className="card">
          <h2>Failed jobs</h2>
          {(data?.jobs ?? []).map((job) => (
            <div key={job.id} style={{ marginBottom: "0.7rem" }}>
              <strong>{job.type}</strong> <StatusBadge value={job.status} />
              <div className="muted">{job.error}</div>
              {job.request_id ? <Link to={`/requests/${job.request_id}`}>open request</Link> : null}
            </div>
          ))}
        </div>
        <div className="card">
          <h2>LLM errors</h2>
          {(data?.llm_calls ?? []).map((call) => (
            <div key={call.id} style={{ marginBottom: "0.7rem" }}>
              <div>
                {call.model} · parsed {call.parsed_ok ? "ok" : "no"}
              </div>
              <div className="muted">{call.error ?? call.prompt}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="card" style={{ marginTop: "1rem" }}>
        <h2>Recent transitions</h2>
        {(data?.events ?? []).slice(0, 40).map((ev) => (
          <div key={ev.id} className="muted">
            <Link to={`/requests/${ev.request_id}`}>{ev.request_id.slice(0, 8)}</Link> {ev.from_status} → {ev.to_status} ·{" "}
            {ev.actor}
          </div>
        ))}
      </div>
    </>
  );
}
