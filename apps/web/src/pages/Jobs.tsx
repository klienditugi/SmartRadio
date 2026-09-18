import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import { useAuth } from "../auth";
import type { JobRow } from "../types";

export function JobsPage() {
  const { user } = useAuth();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await api<{ jobs: JobRow[] }>("/admin/jobs");
    setJobs(res.jobs);
  }

  useEffect(() => {
    void load().catch((err) => setError((err as Error).message));
    const id = setInterval(() => void load().catch(() => undefined), 4000);
    return () => clearInterval(id);
  }, []);

  async function cancel(id: string) {
    await api(`/admin/jobs/${id}/cancel`, { method: "POST" });
    await load();
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Jobs</h1>
          <p className="lede">Worker lease queue. API only enqueues; workers own provider I/O.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Status</th>
              <th>Request</th>
              <th>Attempts</th>
              <th>Error</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.type}</td>
                <td>
                  <StatusBadge value={job.status} />
                </td>
                <td>
                  {job.request_id ? <Link to={`/requests/${job.request_id}`}>{job.request_id.slice(0, 8)}</Link> : "—"}
                </td>
                <td>
                  {job.attempts}/{job.max_attempts}
                </td>
                <td className="muted">{job.error ?? ""}</td>
                <td>
                  {user?.role === "admin" && (job.status === "queued" || job.status === "running") ? (
                    <button className="btn danger" type="button" onClick={() => void cancel(job.id)}>
                      Cancel
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
