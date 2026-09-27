import { useEffect, useState } from "react";
import { api } from "../api";

export type IntegrationKind = "llm" | "library" | "radio";

type IntegrationSettings = {
  verify_status: string;
  base_url: string;
};

type IntegrationReport = {
  ok: boolean;
  state: string;
  probed: boolean;
  detail: string;
  settings: IntegrationSettings;
};

const TITLES: Record<IntegrationKind, string> = {
  llm: "Ollama",
  library: "Navidrome",
  radio: "SUB/WAVE",
};

function statusClass(state: string): string {
  if (state === "ready") return "badge ok";
  if (state === "configured_unverified" || state === "not_configured") return "badge warn";
  return "badge bad";
}

export function integrationStatusLabel(state: string): string {
  switch (state) {
    case "not_configured":
      return "Not configured";
    case "configured_unverified":
      return "Configured, unverified";
    case "unreachable":
      return "Unreachable";
    case "auth_failed":
      return "Auth failed";
    case "model_missing":
      return "Model missing";
    case "unhealthy":
      return "Unhealthy";
    case "ready":
      return "Ready";
    default:
      return state;
  }
}

export function IntegrationProbe(props: { kind: IntegrationKind; readOnly?: boolean }) {
  const [status, setStatus] = useState<IntegrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const title = TITLES[props.kind];

  useEffect(() => {
    let cancel = false;
    api<IntegrationReport>(`/${props.kind}/status`)
      .then((live) => {
        if (!cancel) {
          setStatus(live);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancel) setError((err as Error).message);
      });
    return () => {
      cancel = true;
    };
  }, [props.kind]);

  async function onTest() {
    setBusy(true);
    setError(null);
    try {
      const live = await api<IntegrationReport>(`/${props.kind}/test-connection`, { method: "POST" });
      setStatus(live);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ boxShadow: "none", marginTop: "0.8rem" }}>
      <h3>{title}</h3>
      <p className="muted">Saving settings does not mark {title} verified. Test connection is read-only.</p>
      {error ? <div className="error">{error}</div> : null}
      {status ? (
        <>
          <div className="row">
            <span className={statusClass(status.state)} role="status">
              {integrationStatusLabel(status.state)}
            </span>
            <span className="muted">saved verification: {status.settings.verify_status}</span>
          </div>
          <p className="muted">{status.detail}</p>
          {status.state === "ready" ? <p className="muted">Restart the worker so it reloads verified {title}.</p> : null}
        </>
      ) : (
        <p className="muted">Loading {title} status…</p>
      )}
      {props.readOnly ? null : (
        <button className="btn" type="button" disabled={busy || !status} onClick={() => void onTest()}>
          Test connection
        </button>
      )}
    </div>
  );
}
