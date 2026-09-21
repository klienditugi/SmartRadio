import { useEffect, useState } from "react";
import { api, bytes } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import type { DiskSnapshot } from "../types";

export function DiskPage() {
  const [volumes, setVolumes] = useState<DiskSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api<{ volumes: DiskSnapshot[] }>("/ops/disk")
        .then((res) => setVolumes(res.volumes))
        .catch((err) => setError((err as Error).message));
    void load();
    const id = setInterval(() => void load(), 8000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Disk space</h1>
          <p className="lede">Host-mounted downloads, staging, library, database, and secrets directories.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="grid two">
        {volumes.map((vol) => (
          <div className="card" key={vol.role}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2>{vol.role}</h2>
              <StatusBadge value={vol.ok ? "ok" : "error"} />
            </div>
            <div className="muted">{vol.path}</div>
            <div className="stat" style={{ margin: "0.6rem 0" }}>
              {bytes(vol.free_bytes)} free
            </div>
            <div className="progress">
              <span style={{ width: `${Math.min(100, (vol.used_ratio ?? 0) * 100)}%` }} />
            </div>
            <p className="muted">
              {bytes(vol.used_bytes)} used of {bytes(vol.total_bytes)}
              {vol.error ? ` · ${vol.error}` : ""}
            </p>
          </div>
        ))}
      </div>
    </>
  );
}
