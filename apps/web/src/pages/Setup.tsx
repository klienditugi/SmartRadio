import { FormEvent, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { AcquisitionForm } from "../components/AcquisitionForm";
import { IntegrationProbe } from "../components/IntegrationProbe";

const STEPS = ["Admin", "Paths", "Ollama", "Navidrome", "Radio", "Acquisition", "Review"];

type FormState = {
  admin_username: string;
  admin_password: string;
  library: string;
  downloads: string;
  staging: string;
  ollama_url: string;
  ollama_model: string;
  navidrome_url: string;
  navidrome_user: string;
  navidrome_password: string;
  radio_url: string;
  radio_user: string;
  radio_password: string;
  slskd_url: string;
  slskd_key: string;
  acquisition_enabled: boolean;
  acquisition_provider: string;
};

const EMPTY: FormState = {
  admin_username: "admin",
  admin_password: "",
  library: "",
  downloads: "",
  staging: "",
  ollama_url: "",
  ollama_model: "",
  navidrome_url: "",
  navidrome_user: "",
  navidrome_password: "",
  radio_url: "",
  radio_user: "",
  radio_password: "",
  slskd_url: "",
  slskd_key: "",
  acquisition_enabled: false,
  acquisition_provider: "slskd",
};

export function SetupPage() {
  const { user, setup, refreshSetup } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bootstrap = Boolean(setup && !setup.configured);

  type TextKey = { [K in keyof FormState]: FormState[K] extends string ? K : never }[keyof FormState];
  const set = (key: TextKey, value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  const payload = useMemo(
    () => ({
      setup_complete: true,
      secrets: {
        ...(form.admin_password ? { admin_password: form.admin_password } : {}),
        ...(form.navidrome_password ? { navidrome_password: form.navidrome_password } : {}),
        ...(form.radio_password ? { subwave_admin_password: form.radio_password } : {}),
        ...(form.slskd_key ? { slskd_api_key: form.slskd_key } : {}),
      },
      config: {
        auth: form.admin_username ? { admin_username: form.admin_username } : undefined,
        paths: {
          ...(form.library ? { library: form.library } : {}),
          ...(form.downloads ? { downloads: form.downloads } : {}),
          ...(form.staging ? { staging: form.staging } : {}),
        },
        llm: {
          ...(form.ollama_url ? { base_url: form.ollama_url } : {}),
          ...(form.ollama_model ? { model: form.ollama_model } : {}),
        },
        library: {
          ...(form.navidrome_url ? { base_url: form.navidrome_url } : {}),
          ...(form.navidrome_user ? { username: form.navidrome_user } : {}),
        },
        radio: {
          ...(form.radio_url ? { base_url: form.radio_url } : {}),
          ...(form.radio_user ? { admin_user: form.radio_user } : {}),
        },
        ...(bootstrap
          ? {
              acquisition: {
                enabled: form.acquisition_enabled,
                provider: form.acquisition_provider || "slskd",
                ...(form.slskd_url ? { base_url: form.slskd_url } : {}),
              },
            }
          : {}),
      },
    }),
    [bootstrap, form],
  );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (step < STEPS.length - 1) {
      setStep((s) => s + 1);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/setup", { method: "POST", body: JSON.stringify(payload) });
      await refreshSetup();
      navigate(user ? "/" : "/login");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wizard">
      <strong style={{ color: "var(--amber)", letterSpacing: "0.12em", fontSize: "0.78rem" }}>FIRST-RUN / SETTINGS</strong>
      <h1>{bootstrap ? "Configure this station" : "Update configuration"}</h1>
      <p className="lede">
        No IPs, hosts, ports, credentials, or model names are hard-coded. Ollama is an external daemon — this wizard never
        installs or pulls models.
      </p>
      <div className="steps">
        {STEPS.map((label, index) => (
          <span key={label} className={index === step ? "on" : undefined}>
            {index + 1}. {label}
          </span>
        ))}
      </div>
      {setup?.missing?.length ? <p className="muted">Currently missing: {setup.missing.join(", ")}</p> : null}
      {error ? <div className="error">{error}</div> : null}
      <form onSubmit={onSubmit}>
        {step === 0 && (
          <>
            <label className="field">
              <span>Admin username</span>
              <input value={form.admin_username} onChange={(e) => set("admin_username", e.target.value)} required={bootstrap} />
            </label>
            <label className="field">
              <span>Admin password {bootstrap ? "(required)" : "(leave blank to keep)"}</span>
              <input type="password" value={form.admin_password} onChange={(e) => set("admin_password", e.target.value)} />
            </label>
          </>
        )}
        {step === 1 && (
          <>
            <p className="muted">Persistent host paths. Music must not live only in an ephemeral container.</p>
            <label className="field">
              <span>Library directory</span>
              <input value={form.library} onChange={(e) => set("library", e.target.value)} placeholder="host path" />
            </label>
            <label className="field">
              <span>Downloads directory</span>
              <input value={form.downloads} onChange={(e) => set("downloads", e.target.value)} />
            </label>
            <label className="field">
              <span>Staging directory</span>
              <input value={form.staging} onChange={(e) => set("staging", e.target.value)} />
            </label>
          </>
        )}
        {step === 2 && (
          <>
            <p className="muted">
              Optional at boot. External Ollama only — leave blank and status stays not_configured. Enter a base URL and a
              model already present on that host. This wizard never installs Ollama or chooses a model.
            </p>
            <label className="field">
              <span>Ollama base URL</span>
              <input value={form.ollama_url} onChange={(e) => set("ollama_url", e.target.value)} placeholder="https://…" />
            </label>
            <label className="field">
              <span>Model name (no default)</span>
              <input value={form.ollama_model} onChange={(e) => set("ollama_model", e.target.value)} />
            </label>
            <p className="muted">Saving this step does not mark Ollama verified. Sign in, then use Test connection.</p>
            {user?.role === "admin" ? <IntegrationProbe kind="llm" /> : null}
          </>
        )}
        {step === 3 && (
          <>
            <p className="muted">Optional. Leave blank to boot; Navidrome stays not_configured until URL, username, and password are set.</p>
            <label className="field">
              <span>Navidrome URL</span>
              <input value={form.navidrome_url} onChange={(e) => set("navidrome_url", e.target.value)} />
            </label>
            <label className="field">
              <span>Navidrome username</span>
              <input value={form.navidrome_user} onChange={(e) => set("navidrome_user", e.target.value)} />
            </label>
            <label className="field">
              <span>Navidrome password (written to secrets/)</span>
              <input type="password" value={form.navidrome_password} onChange={(e) => set("navidrome_password", e.target.value)} />
            </label>
            <p className="muted">Saving this step does not mark Navidrome verified. Sign in, then use Test connection.</p>
            {user?.role === "admin" ? <IntegrationProbe kind="library" /> : null}
          </>
        )}
        {step === 4 && (
          <>
            <p className="muted">
              Optional. Leave blank to boot; SUB/WAVE stays not_configured until the opaque base URL, admin username, and
              password are set. A live base URL may already include /api.
            </p>
            <label className="field">
              <span>Radio base URL</span>
              <input value={form.radio_url} onChange={(e) => set("radio_url", e.target.value)} />
            </label>
            <label className="field">
              <span>Admin username</span>
              <input value={form.radio_user} onChange={(e) => set("radio_user", e.target.value)} />
            </label>
            <label className="field">
              <span>Admin password (secrets/)</span>
              <input type="password" value={form.radio_password} onChange={(e) => set("radio_password", e.target.value)} />
            </label>
            <p className="muted">Saving this step does not mark SUB/WAVE verified. Sign in, then use Test connection.</p>
            {user?.role === "admin" ? <IntegrationProbe kind="radio" /> : null}
          </>
        )}
        {step === 5 &&
          (bootstrap ? (
            <AcquisitionForm
              mode="wizard"
              draft={{
                enabled: form.acquisition_enabled,
                provider: form.acquisition_provider,
                base_url: form.slskd_url,
                api_key: form.slskd_key,
                downloads: form.downloads,
                library: form.library,
              }}
              onDraftChange={(draft) =>
                setForm((prev) => ({
                  ...prev,
                  acquisition_enabled: draft.enabled,
                  acquisition_provider: draft.provider,
                  slskd_url: draft.base_url,
                  slskd_key: draft.api_key,
                  downloads: draft.downloads,
                  library: draft.library,
                }))
              }
            />
          ) : (
            <AcquisitionForm mode="settings" readOnly={user?.role !== "admin"} />
          ))}
        {step === 6 && (
          <div className="pre">
            {JSON.stringify(
              {
                ...payload,
                secrets: Object.fromEntries(Object.keys(payload.secrets).map((k) => [k, "(set)"])),
              },
              null,
              2,
            )}
          </div>
        )}
        <div className="row" style={{ marginTop: "1rem" }}>
          {step > 0 ? (
            <button className="btn" type="button" onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
          ) : null}
          <button className="btn primary" disabled={busy} type="submit">
            {step === STEPS.length - 1 ? (busy ? "Saving…" : "Save configuration") : "Next"}
          </button>
        </div>
      </form>
    </div>
  );
}
