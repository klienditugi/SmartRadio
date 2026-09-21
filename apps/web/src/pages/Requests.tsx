import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import { REQUEST_STATUSES, type RequestRow } from "../types";

export function RequestsPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [status, setStatus] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    const res = await api<{ requests: RequestRow[] }>(`/requests${qs}`);
    setRows(res.requests);
  }

  useEffect(() => {
    void load().catch((err) => setError((err as Error).message));
    const id = setInterval(() => void load().catch(() => undefined), 4000);
    return () => clearInterval(id);
  }, [status]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const res = await api<{ request: RequestRow }>("/requests", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      setText("");
      navigate(`/requests/${res.request.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Request queue</h1>
          <p className="lede">Canonical states from RECEIVED through READY, plus FAILED and CANCELLED.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="card" style={{ marginBottom: "1rem" }}>
        <form className="row" onSubmit={submit}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Artist — title, or free text"
            required
            maxLength={500}
            style={{ flex: 1, minWidth: "12rem" }}
          />
          <button className="btn primary" type="submit">
            Submit request
          </button>
        </form>
      </div>
      <div className="row" style={{ marginBottom: "0.8rem" }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {REQUEST_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Query</th>
              <th>Track</th>
              <th>Status</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="clickable" onClick={() => navigate(`/requests/${row.id}`)}>
                <td>{row.raw_query}</td>
                <td className="muted">{[row.artist, row.title].filter(Boolean).join(" — ") || "—"}</td>
                <td>
                  <StatusBadge value={row.status} />
                </td>
                <td className="muted">{row.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
