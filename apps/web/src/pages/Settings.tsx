import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { AcquisitionForm } from "../components/AcquisitionForm";

type SettingsResponse = {
  config: {
    llm: { base_url: string; model: string };
    library: { base_url: string; username: string };
    radio: { base_url: string; admin_user: string };
    integrations?: {
      llm: { state: string | null };
      library: { state: string | null };
      radio: { state: string | null };
    };
    acquisition: { base_url: string };
    policy: {
      require_electronic: boolean;
      require_station_match: boolean;
      min_confidence: number;
      allowed_genres: string[];
      blocked_artists: string[];
      blocked_terms: string[];
    };
    secrets_present: Record<string, boolean>;
    paths: { library: string; downloads: string; staging: string };
  };
  settings: Record<string, unknown>;
};

export function SettingsPage() {
  const { user } = useAuth();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [policy, setPolicy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<SettingsResponse>("/settings")
      .then((res) => {
        setData(res);
        setPolicy(JSON.stringify(res.config.policy, null, 2));
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  async function savePolicy(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    try {
      const parsed = JSON.parse(policy) as unknown;
      await api("/settings", { method: "PUT", body: JSON.stringify({ policy: parsed }) });
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const cfg = data?.config;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Settings</h1>
          <p className="lede">Runtime config is public (no secrets). Use the wizard to write yaml + secrets files.</p>
        </div>
        <Link className="btn" to="/wizard">
          Open wizard
        </Link>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {cfg ? (
        <div className="grid two">
          <div className="card">
            <h2>Integrations</h2>
            <p>
              <strong>Ollama</strong>{" "}
              {cfg.integrations?.llm.state === "not_configured"
                ? "not_configured"
                : `${cfg.llm.base_url} · model ${cfg.llm.model}`}
            </p>
            <p>
              <strong>Navidrome</strong>{" "}
              {cfg.integrations?.library.state === "not_configured"
                ? "not_configured"
                : `${cfg.library.base_url} · ${cfg.library.username}`}
            </p>
            <p>
              <strong>SUB/WAVE</strong>{" "}
              {cfg.integrations?.radio.state === "not_configured"
                ? "not_configured"
                : `${cfg.radio.base_url} · ${cfg.radio.admin_user}`}
            </p>
            <p>
              <strong>Acquisition</strong> slskd URL and API key are edited below. Soulseek username and password stay in slskd.
            </p>
            <h3>Secrets present</h3>
            <div className="pre">{JSON.stringify(cfg.secrets_present, null, 2)}</div>
          </div>
          <div className="card">
            <h2>Paths</h2>
            <p className="muted">{cfg.paths.library}</p>
            <p className="muted">{cfg.paths.downloads}</p>
            <p className="muted">{cfg.paths.staging}</p>
            {user?.role === "admin" ? (
              <form onSubmit={savePolicy}>
                <label className="field">
                  <span>Station policy JSON (deterministic; LLM does not approve)</span>
                  <textarea value={policy} onChange={(e) => setPolicy(e.target.value)} />
                </label>
                <button className="btn primary" type="submit">
                  Save policy setting
                </button>
                {saved ? <span className="muted"> Saved to SQLite settings.</span> : null}
              </form>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="card" style={{ marginTop: "1rem" }}>
        <h2>Acquisition</h2>
        <AcquisitionForm mode="settings" readOnly={user?.role !== "admin"} />
      </div>
    </>
  );
}
