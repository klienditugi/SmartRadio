import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import {
  acquisitionStatusLabel,
  providerOptions,
  type AcquisitionConnectionReport,
  type AcquisitionDraft,
  type AcquisitionSelectionSettings,
  type AcquisitionSettings,
} from "../acquisition";
import { isEnvPinned, pinNote, type FieldSources } from "../types";

const SELECTION_DEFAULTS: AcquisitionSelectionSettings = {
  preferred_max_file_size_mb: 30,
  max_file_size_mb: 200,
  preferred_max_duration_seconds: 720,
  max_duration_seconds: 1200,
  extended_version_bonus: true,
  lossless_preference: 36,
};

type WizardProps = {
  mode: "wizard";
  draft: AcquisitionDraft;
  onDraftChange: (draft: AcquisitionDraft) => void;
  apiKeyConfigured?: boolean;
  sources?: FieldSources;
};

type SettingsProps = {
  mode: "settings";
  readOnly?: boolean;
  sources?: FieldSources;
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
  sources?: FieldSources;
  onChange: (patch: Partial<AcquisitionDraft>) => void;
}) {
  const urlLocked = props.readOnly || isEnvPinned(props.sources, "acquisition.base_url");
  const downloadsLocked = props.readOnly || isEnvPinned(props.sources, "paths.downloads");
  const libraryLocked = props.readOnly || isEnvPinned(props.sources, "paths.library");
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
          readOnly={urlLocked}
          disabled={props.readOnly}
          onChange={(e) => props.onChange({ base_url: e.target.value })}
          placeholder="http://…"
          autoComplete="off"
        />
      </label>
      <PinLine sources={props.sources} path="acquisition.base_url" />
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
          readOnly={downloadsLocked}
          disabled={props.readOnly}
          onChange={(e) => props.onChange({ downloads: e.target.value })}
          placeholder="completed downloads path"
        />
      </label>
      <PinLine sources={props.sources} path="paths.downloads" />
      <label className="field">
        <span>Library directory</span>
        <input
          value={props.library}
          readOnly={libraryLocked}
          disabled={props.readOnly}
          onChange={(e) => props.onChange({ library: e.target.value })}
          placeholder="final library path"
        />
      </label>
      <PinLine sources={props.sources} path="paths.library" />
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
  const [preferredFileMb, setPreferredFileMb] = useState(String(SELECTION_DEFAULTS.preferred_max_file_size_mb));
  const [hardFileMb, setHardFileMb] = useState(SELECTION_DEFAULTS.max_file_size_mb);
  const [preferredDuration, setPreferredDuration] = useState(String(SELECTION_DEFAULTS.preferred_max_duration_seconds));
  const [hardDuration, setHardDuration] = useState(
    SELECTION_DEFAULTS.max_duration_seconds == null ? "" : String(SELECTION_DEFAULTS.max_duration_seconds),
  );
  const [extendedBonus, setExtendedBonus] = useState(SELECTION_DEFAULTS.extended_version_bonus);
  const [losslessPreference, setLosslessPreference] = useState(String(SELECTION_DEFAULTS.lossless_preference));

  function applySettings(settings: AcquisitionSettings) {
    setLoaded(settings);
    setEnabled(settings.enabled);
    setProvider(settings.provider || "slskd");
    setBaseUrl(settings.base_url);
    setDownloads(settings.paths.downloads);
    setLibrary(settings.paths.library);
    setApiKey("");
    const selection = settings.selection ?? SELECTION_DEFAULTS;
    setPreferredFileMb(String(selection.preferred_max_file_size_mb));
    setHardFileMb(selection.max_file_size_mb);
    setPreferredDuration(String(selection.preferred_max_duration_seconds));
    setHardDuration(selection.max_duration_seconds == null ? "" : String(selection.max_duration_seconds));
    setExtendedBonus(selection.extended_version_bonus);
    setLosslessPreference(String(selection.lossless_preference));
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
          sources={props.sources}
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
  const fieldSources = props.sources ?? loaded?.sources;
  const preferredSizeLocked = readOnly || isEnvPinned(fieldSources, "acquisition.selection.preferred_max_file_size_mb");
  const preferredDurationLocked = readOnly || isEnvPinned(fieldSources, "acquisition.selection.preferred_max_duration_seconds");
  const hardDurationLocked = readOnly || isEnvPinned(fieldSources, "acquisition.selection.max_duration_seconds");
  const bonusLocked = readOnly || isEnvPinned(fieldSources, "acquisition.selection.extended_version_bonus");
  const losslessLocked = readOnly || isEnvPinned(fieldSources, "acquisition.selection.lossless_preference");

  function patchLocal(patch: Partial<AcquisitionDraft>) {
    if (patch.enabled !== undefined) setEnabled(patch.enabled);
    if (patch.provider !== undefined) setProvider(patch.provider);
    if (patch.base_url !== undefined) setBaseUrl(patch.base_url);
    if (patch.api_key !== undefined) setApiKey(patch.api_key);
    if (patch.downloads !== undefined) setDownloads(patch.downloads);
    if (patch.library !== undefined) setLibrary(patch.library);
  }

  function selectionBody() {
    const preferredSize = Number(preferredFileMb);
    const preferredSeconds = Number(preferredDuration);
    const lossless = Number(losslessPreference);
    const hardSeconds = hardDuration.trim() === "" ? null : Number(hardDuration);
    return {
      preferred_max_file_size_mb: preferredSize,
      preferred_max_duration_seconds: preferredSeconds,
      max_duration_seconds: hardSeconds,
      extended_version_bonus: extendedBonus,
      lossless_preference: lossless,
    };
  }

  function selectionError(): string | null {
    const body = selectionBody();
    if (!Number.isFinite(body.preferred_max_file_size_mb) || body.preferred_max_file_size_mb <= 0) {
      return "preferred_max_file_size_mb must be a positive number";
    }
    if (body.preferred_max_file_size_mb > hardFileMb) {
      return "preferred_max_file_size_mb must be <= max_file_size_mb";
    }
    if (!Number.isFinite(body.preferred_max_duration_seconds) || body.preferred_max_duration_seconds <= 0) {
      return "preferred_max_duration_seconds must be a positive number";
    }
    if (body.max_duration_seconds !== null && (!Number.isFinite(body.max_duration_seconds) || body.max_duration_seconds <= 0)) {
      return "max_duration_seconds must be a positive number or empty";
    }
    if (body.max_duration_seconds !== null && body.preferred_max_duration_seconds > body.max_duration_seconds) {
      return "preferred_max_duration_seconds must be <= max_duration_seconds";
    }
    if (!Number.isFinite(body.lossless_preference) || body.lossless_preference < 0) {
      return "lossless_preference must be a number greater than or equal to 0";
    }
    return null;
  }

  function requestBody() {
    return {
      enabled,
      provider,
      base_url: baseUrl,
      paths: { downloads, library },
      selection: selectionBody(),
      ...(apiKey ? { slskd_api_key: apiKey } : {}),
    };
  }

  function dirty(): boolean {
    if (!loaded) return apiKey !== "";
    const selection = loaded.selection ?? SELECTION_DEFAULTS;
    const body = selectionBody();
    return (
      apiKey !== "" ||
      enabled !== loaded.enabled ||
      provider !== loaded.provider ||
      baseUrl !== loaded.base_url ||
      downloads !== loaded.paths.downloads ||
      library !== loaded.paths.library ||
      body.preferred_max_file_size_mb !== selection.preferred_max_file_size_mb ||
      body.preferred_max_duration_seconds !== selection.preferred_max_duration_seconds ||
      body.max_duration_seconds !== selection.max_duration_seconds ||
      body.extended_version_bonus !== selection.extended_version_bonus ||
      body.lossless_preference !== selection.lossless_preference
    );
  }

  async function persist(): Promise<boolean> {
    const invalid = selectionError();
    if (invalid) {
      setError(invalid);
      setSavedNote(false);
      return false;
    }
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
          sources={props.sources}
          onChange={patchLocal}
        />
      ) : null}
      {loaded ? (
        <>
          <h3>Which file to download</h3>
          <p className="muted">
            Hard max file size is {hardFileMb} MiB. A file above the preferred size is penalized, not dropped, until it
            hits that hard max. Preferred size and preferred duration must stay at or under the hard limits.
          </p>
          <label className="field">
            <span>Preferred max file size (MiB)</span>
            <input
              type="number"
              min={1}
              step={1}
              value={preferredFileMb}
              readOnly={preferredSizeLocked}
              disabled={readOnly}
              onChange={(e) => setPreferredFileMb(e.target.value)}
            />
          </label>
          <SourceLine sources={fieldSources} path="acquisition.selection.preferred_max_file_size_mb" />
          <label className="field check">
            <input
              type="checkbox"
              checked={extendedBonus}
              disabled={bonusLocked}
              onChange={(e) => setExtendedBonus(e.target.checked)}
            />
            <span>Prefer extended mixes and remixes</span>
          </label>
          <SourceLine sources={fieldSources} path="acquisition.selection.extended_version_bonus" />
          <label className="field">
            <span>Preferred max duration (seconds)</span>
            <input
              type="number"
              min={1}
              step={1}
              value={preferredDuration}
              readOnly={preferredDurationLocked}
              disabled={readOnly}
              onChange={(e) => setPreferredDuration(e.target.value)}
            />
          </label>
          <SourceLine sources={fieldSources} path="acquisition.selection.preferred_max_duration_seconds" />
          <label className="field">
            <span>Hard max duration (seconds)</span>
            <input
              type="number"
              min={1}
              step={1}
              value={hardDuration}
              readOnly={hardDurationLocked}
              disabled={readOnly}
              placeholder="empty disables the cap"
              onChange={(e) => setHardDuration(e.target.value)}
            />
          </label>
          <SourceLine sources={fieldSources} path="acquisition.selection.max_duration_seconds" />
          <p className="muted">Leave hard max duration empty to disable it. Files with no duration stay eligible.</p>
          <label className="field">
            <span>Lossless preference</span>
            <input
              type="number"
              min={0}
              step={1}
              value={losslessPreference}
              readOnly={losslessLocked}
              disabled={readOnly}
              onChange={(e) => setLosslessPreference(e.target.value)}
            />
          </label>
          <SourceLine sources={fieldSources} path="acquisition.selection.lossless_preference" />
          <p className="muted">
            Default 36 picks a normal 6-minute 16/44.1 FLAC over a 320 kbps MP3. 0 picks the MP3.
          </p>
        </>
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

function PinLine(props: { sources?: FieldSources; path: string }) {
  const note = pinNote(props.sources, props.path);
  if (!note) return null;
  return <p className="muted">{note}</p>;
}

function sourceLabel(sources: FieldSources | undefined, path: string): string | null {
  const field = sources?.[path];
  if (!field) return null;
  if (field.source === "env" && field.env) return `set by ${field.env} in .env`;
  return `source: ${field.source}`;
}

function SourceLine(props: { sources?: FieldSources; path: string }) {
  const label = sourceLabel(props.sources, props.path);
  if (!label) return null;
  return <p className="muted">{label}</p>;
}
