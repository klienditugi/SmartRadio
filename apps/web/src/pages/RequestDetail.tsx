import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import { useAuth } from "../auth";
import { approveActionCopy } from "../adminActions";
import type { AcquisitionRow, JobRow, RequestEventRow, RequestRow } from "../types";

type Detail = {
  request: RequestRow;
  events: RequestEventRow[];
  jobs: JobRow[];
  acquisitions: AcquisitionRow[];
  matches: unknown[];
  llm_calls: Array<{ id: string; model: string; parsed_ok: number; error: string | null; latency_ms: number | null }>;
};

export function RequestDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const admin = user?.role === "admin";

  async function load() {
    if (!id) return;
    setData(await api<Detail>(`/requests/${id}`));
  }

  useEffect(() => {
    void load().catch((err) => setError((err as Error).message));
    const timer = setInterval(() => void load().catch(() => undefined), 3000);
    return () => clearInterval(timer);
  }, [id]);

  async function act(path: string) {
    if (!id) return;
    setError(null);
    try {
      await api(`/requests/${id}/${path}`, { method: "POST" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const req = data?.request;
  const approveCopy = req ? approveActionCopy(req.status) : null;
  const download = data?.acquisitions?.[0];
  const pct = download?.progress != null ? Math.round(download.progress * 100) : null;

  async function onApprove() {
    if (!req || !approveCopy) return;
    if (approveCopy.confirm && !window.confirm(approveCopy.confirm)) return;
    await act("approve");
  }

  return (
    <>
      <p>
        <Link to="/requests">← Queue</Link>
      </p>
      <div className="topbar">
        <div>
          <h1>{req?.raw_query ?? "Request"}</h1>
          <p className="lede">{req ? [req.artist, req.title, req.genre].filter(Boolean).join(" · ") : "Loading…"}</p>
        </div>
        {req ? <StatusBadge value={req.status} /> : null}
      </div>
      {error ? <div className="error">{error}</div> : null}
      {admin && req ? (
        <div className="row" style={{ marginBottom: "1rem" }}>
          <button
            className="btn"
            type="button"
            title={approveCopy?.title}
            aria-label={approveCopy?.title}
            onClick={() => void onApprove()}
          >
            {approveCopy?.label}
          </button>
          <button className="btn danger" type="button" onClick={() => void act("reject")}>
            Reject
          </button>
          <button className="btn" type="button" onClick={() => void act("reclassify")}>
            Re-run classification
          </button>
          <button className="btn" type="button" onClick={() => void act("retry")}>
            Retry
          </button>
          <button className="btn" type="button" onClick={() => void act("retry-acquisition")}>
            Retry acquisition
          </button>
          <button className="btn danger" type="button" onClick={() => void act("cancel")}>
            Cancel
          </button>
        </div>
      ) : null}
      {admin && req?.status === "REJECTED" ? (
        <p className="muted" style={{ marginTop: "-0.4rem", marginBottom: "1rem" }}>
          Override to APPROVED is an explicit operator override. It skips reclassification and keeps the existing
          classification.
        </p>
      ) : null}
      {download ? (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h2>Download progress</h2>
          <div className="muted">
            {download.filename ?? "transfer"} {download.remote_user ? `· ${download.remote_user}` : ""} · {download.status}
          </div>
          <div className="progress" style={{ marginTop: "0.5rem" }}>
            <span style={{ width: `${pct ?? 0}%` }} />
          </div>
          <div className="muted" style={{ marginTop: "0.35rem" }}>
            {pct === null
              ? "Progress fields on slskd transfer JSON are NEEDS_SERVER_INSPECTION; showing status snapshot only."
              : `${pct}%`}
          </div>
        </div>
      ) : null}
      {req?.error ? <div className="error">{req.error}</div> : null}
      <div className="grid two">
        <div className="card">
          <h2>State log</h2>
          {(data?.events ?? []).map((ev) => (
            <div key={ev.id} style={{ marginBottom: "0.55rem" }}>
              <StatusBadge value={ev.from_status} /> → <StatusBadge value={ev.to_status} />
              <div className="muted">
                {ev.actor} · {new Date(ev.created_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>Jobs</h2>
          {(data?.jobs ?? []).map((job) => (
            <div key={job.id} style={{ marginBottom: "0.55rem" }}>
              <strong>{job.type}</strong> <StatusBadge value={job.status} />
              <div className="muted">
                attempts {job.attempts}/{job.max_attempts}
                {job.error ? ` · ${job.error}` : ""}
              </div>
            </div>
          ))}
        </div>
      </div>
      {data?.llm_calls?.length ? (
        <div className="card" style={{ marginTop: "1rem" }}>
          <h2>Classification calls</h2>
          {data.llm_calls.map((call) => (
            <div key={call.id} className="muted">
              {call.model} · parsed {call.parsed_ok ? "ok" : "no"} · {call.latency_ms ?? "?"}ms
              {call.error ? ` · ${call.error}` : ""}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
