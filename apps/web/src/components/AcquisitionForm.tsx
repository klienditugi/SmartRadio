import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import {
  acquisitionStatusLabel,
  providerOptions,
  type AcquisitionConnectionReport,
  type AcquisitionDraft,
  type AcquisitionSettings,
} from "../acquisition";

type WizardProps = {
  mode: "wizard";
  draft: AcquisitionDraft;
  onDraftChange: (draft: AcquisitionDraft) => void;
  apiKeyConfigured?: boolean;
};

type SettingsProps = {
  mode: "settings";
  readOnly?: boolean;
};

function statusClass(state: string): string {
  if (state === "ready") return "badge ok";
  if (state === "reachable") return "badge info";
  if (state === "disabled" || state === "not_configured") return "badge warn";
  return "badge bad";
}

function Fields(props: {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  apiKey: string;
  downloads: string;
  library: string;
  providers: string[];
  apiKeyConfigured: boolean;
  readOnly: boolean;
  onChange: (patch: Partial<AcquisitionDraft>) => void;
}) {
  return (
    <>
      <p className="muted">
        Soulseek username and password belong to slskd. SmartRadio stores only the slskd URL and a write-only API key.
      </p>
      <label className="field check">
        <input
          type="checkbox"
          checked={props.enabled}
          disabled={props.readOnly}
          onChange={(e) => props.onChange({ enabled: e.target.checked })}
        />
        <span>Acquisition enabled</span>
      </label>
      <label className="field">
        <span>Provider</span>
        <select
          value={props.provider}
          disabled={props.readOnly}
          onChange={(e) => props.onChange({ provider: e.target.value })}
        >
          {props.providers.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">slskd is the provider with a live connection check. Other names can be saved for later.</p>
      <label className="field">
        <span>slskd URL</span>
        <input
          value={props.baseUrl}
          disabled={props.readOnly}
          onChange={(e) => props.onChange({ base_url: e.target.value })}
          placeholder="http://…"
          autoComplete="off"
        />
      </label>
      <label className="field">
        <span>slskd API key</span>
        <input
          type="password"
          value={props.apiKey}
          disabled={props.readOnly}
          onChange={(e) => props.onChange({ api_key: e.target.value })}
          placeholder={props.apiKeyConfigured ? "Leave blank to keep the saved key" : "Enter API key"}
          autoComplete="new-password"
        />
      </label>
      <p className="muted">
        Write-only. <span className={props.apiKeyConfigured ? "badge ok" : "badge warn"}>{props.apiKeyConfigured ? "Configured" : "Not set"}</span>{" "}
        Stored in secrets/slskd_api_key. The saved key is never sent back to the browser.
      </p>
      <label className="field">
        <span>Downloads directory</span>
        <input
          value={props.downloads}
          disabled={props.readOnly}
          onChange={(e) => props.onChange({ downloads: e.target.value })}
          placeholder="completed downloads path"
        />
      </label>
      <label className="field">
        <span>Library directory</span>
        <input
          value={props.library}
          disabled={props.readOnly}
          onChange={(e) => props.onChange({ library: e.target.value })}
          placeholder="final library path"
        />
      </label>
    </>
  );
}

export function AcquisitionForm(props: WizardProps | SettingsProps) {
  const readOnly = props.mode === "settings" ? Boolean(props.readOnly) : false;
  const [loaded, setLoaded] = useState<AcquisitionSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState("slskd");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [downloads, setDownloads] = useState("");
  const [library, setLibrary] = useState("");
  const [status, setStatus] = useState<AcquisitionConnectionReport | null>(null);
  const [testedReady, setTestedReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedNote, setSavedNote] = useState(false);

  function applySettings(settings: AcquisitionSettings) {
    setLoaded(settings);
    setEnabled(settings.enabled);
    setProvider(settings.provider || "slskd");
    setBaseUrl(settings.base_url);
    setDownloads(settings.paths.downloads);
    setLibrary(settings.paths.library);
    setApiKey("");
  }

  useEffect(() => {
    if (props.mode !== "settings") return;
    let cancel = false;
    (async () => {
      try {
        const settings = await api<AcquisitionSettings>("/acquisition/settings");
        const live = await api<AcquisitionConnectionReport>("/acquisition/status");
        if (cancel) return;
        applySettings(settings);
        setStatus(live);
        setError(null);
      } catch (err) {
        if (!cancel) setError((err as Error).message);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [props.mode]);

  if (props.mode === "wizard") {
    const draft = props.draft;
    return (
      <div>
        <Fields
          enabled={draft.enabled}
          provider={draft.provider}
          baseUrl={draft.base_url}
          apiKey={draft.api_key}
          downloads={draft.downloads}
          library={draft.library}
          providers={providerOptions(draft.provider, ["slskd"])}
          apiKeyConfigured={Boolean(props.apiKeyConfigured)}
          readOnly={false}
          onChange={(patch) => props.onDraftChange({ ...draft, ...patch })}
        />
        <p className="muted">
          Saving these fields does not mark acquisition verified. Sign in, then use Test connection. That action only
          reads slskd application and server health.
        </p>
      </div>
    );
  }

  const providers = providerOptions(provider, ["slskd"]);
  const apiKeyConfigured = loaded?.secrets_present.slskd_api_key ?? false;

  function patchLocal(patch: Partial<AcquisitionDraft>) {
    if (patch.enabled !== undefined) setEnabled(patch.enabled);
    if (patch.provider !== undefined) setProvider(patch.provider);
    if (patch.base_url !== undefined) setBaseUrl(patch.base_url);
    if (patch.api_key !== undefined) setApiKey(patch.api_key);
    if (patch.downloads !== undefined) setDownloads(patch.downloads);
    if (patch.library !== undefined) setLibrary(patch.library);
  }

  function requestBody() {
    return {
      enabled,
      provider,
      base_url: baseUrl,
      paths: { downloads, library },
      ...(apiKey ? { slskd_api_key: apiKey } : {}),
    };
  }

  function dirty(): boolean {
    if (!loaded) return apiKey !== "";
    return (
      apiKey !== "" ||
      enabled !== loaded.enabled ||
      provider !== loaded.provider ||
      baseUrl !== loaded.base_url ||
      downloads !== loaded.paths.downloads ||
      library !== loaded.paths.library
    );
  }

  async function persist(): Promise<boolean> {
    setBusy(true);
    setError(null);
    setSavedNote(false);
    setTestedReady(false);
    try {
      const settings = await api<AcquisitionSettings>("/acquisition/settings", {
        method: "PUT",
        body: JSON.stringify(requestBody()),
      });
      applySettings(settings);
      setSavedNote(true);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onSave(event: FormEvent) {
    event.preventDefault();
    const ok = await persist();
    if (!ok) return;
    try {
      setStatus(await api<AcquisitionConnectionReport>("/acquisition/status"));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onTest() {
    if (dirty()) {
      const ok = await persist();
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      const live = await api<AcquisitionConnectionReport>("/acquisition/test-connection", { method: "POST" });
      setStatus(live);
      applySettings(live.settings);
      setTestedReady(live.state === "ready");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSave}>
      {error ? <div className="error">{error}</div> : null}
      {!loaded && !error ? <p className="muted">Loading acquisition settings…</p> : null}
      {loaded ? (
        <Fields
          enabled={enabled}
          provider={provider}
          baseUrl={baseUrl}
          apiKey={apiKey}
          downloads={downloads}
          library={library}
          providers={providers}
          apiKeyConfigured={apiKeyConfigured}
          readOnly={readOnly}
          onChange={patchLocal}
        />
      ) : null}
      {status ? (
        <div className="card" style={{ boxShadow: "none", marginBottom: "0.8rem" }}>
          <div className="row">
            <span className={statusClass(status.state)} role="status">
              {acquisitionStatusLabel(status.state)}
            </span>
            <span className="muted">saved verification: {status.settings.verify_status}</span>
          </div>
          <p className="muted">{status.detail}</p>
          {testedReady ? <p className="muted">Restart the worker so it reloads verified acquisition.</p> : null}
        </div>
      ) : null}
      {savedNote ? <p className="muted">Saved. A filled-in form is not a connection. Use Test connection.</p> : null}
      {readOnly ? null : (
        <div className="row">
          <button className="btn primary" type="submit" disabled={busy || !loaded}>
            Save acquisition
          </button>
          <button className="btn" type="button" disabled={busy || !loaded} onClick={() => void onTest()}>
            Test connection
          </button>
        </div>
      )}
    </form>
  );
}
