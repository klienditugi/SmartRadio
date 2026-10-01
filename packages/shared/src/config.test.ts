import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  applyEnvOverrides,
  DEFAULT_MAX_BIT_DEPTH,
  DEFAULT_BITRATE_FLOOR_KBPS,
  DEFAULT_SHORT_RECORDING_FLOOR_SECONDS,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_SLSKD_DOWNLOADS_DIR,
  DEFAULT_SEARCH_VISIBLE_TIMEOUT_MS,
  DEFAULT_SHORT_RECORDING_FRACTION,
  DEFAULT_SHORT_RECORDING_MIN_SAMPLES,
  DEFAULT_SHORT_RECORDING_PENALTY,
  DEFAULT_EXTENDED_VERSION_TERMS,
  DEFAULT_FORMAT_PREFERENCE,
  DEFAULT_LONG_RECORDING_PHRASES,
  DEFAULT_VERSION_PREFERENCE,
  DEFAULT_MAX_DURATION_SECONDS,
  DEFAULT_MAX_FILE_SIZE_MB,
  DEFAULT_MIN_FILE_SIZE_MB,
  DEFAULT_MAX_SAMPLE_RATE,
  DEFAULT_PREFERRED_MAX_DURATION_SECONDS,
  DEFAULT_PREFERRED_MAX_FILE_SIZE_MB,
  DEFAULT_INSTRUMENT_PART_BASENAMES,
  DEFAULT_VERSION_PENALTY_TERMS,
  integrationStatus,
  resetDeprecatedVerifyStatusWarning,
  interpolateEnv,
  loadConfig,
  normalizeAcquisitionSettingsPatch,
  resetDeprecatedSelectionWarning,
  selectionDeprecationNotes,
  parseAppConfig,
  publicSettings,
  serializeAppConfig,
} from "./config.js";
import { parseClassification, parseClassificationJson, safeParseClassification } from "./classification.js";
import { fieldSourcesFor } from "./field-source.js";

const exampleYamlObject = {
  server: { host: "127.0.0.1", port: 8788 },
  database: { path: "./data/subwave.sqlite" },
  paths: {
    secrets_dir: "./secrets",
    downloads: "./data/downloads",
    staging: "./data/staging",
    library: "./data/library",
  },
  files: { allowed_extensions: [".flac", ".mp3"], max_bytes: 1000 },
  auth: { admin_username: "admin", session_ttl_hours: 12, cookie_name: "subwave_session" },
  worker: { id: "worker-1", poll_ms: 250, lease_ms: 10000, max_attempts: 3 },
  policy: {
    require_electronic: true,
    require_station_match: true,
    min_confidence: 0.7,
    allowed_genres: ["techno"],
    blocked_artists: [],
    blocked_terms: [],
  },
  llm: {
    provider: "ollama",
    base_url: "http://127.0.0.1:11434",
    model: "configured-model",
    timeout_ms: 1000,
    verify_status: "verified",
  },
  library: {
    provider: "navidrome",
    base_url: "http://navidrome.example",
    username: "nd",
    client_name: "subwave-ai",
    api_version: "1.16.1",
    verify_status: "verified",
  },
  radio: {
    provider: "subwave",
    base_url: "http://radio.example/api",
    admin_user: "dj",
    verify_status: "verified",
  },
  acquisition: {
    provider: "slskd",
    base_url: "http://slskd.example",
    verify_status: "verified",
  },
};

describe("config", () => {
  it("parses a complete config object", () => {
    const cfg = parseAppConfig(exampleYamlObject);
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.llm.model).toBe("configured-model");
    expect(cfg.llm.provider).toBe("ollama");
    expect(cfg.library.provider).toBe("navidrome");
    expect(cfg.radio.provider).toBe("subwave");
    expect(cfg.acquisition.provider).toBe("slskd");
    expect(cfg.llm.verify_status).toBe("verified");
    expect(cfg.library.verify_status).toBe("verified");
    expect(cfg.radio.verify_status).toBe("verified");
  });

  it("accepts an empty LLM model without inventing a name", () => {
    const raw = structuredClone(exampleYamlObject);
    (raw.llm as { model: string }).model = "   ";
    (raw.llm as { base_url: string }).base_url = "";
    const cfg = parseAppConfig(raw);
    expect(cfg.llm.model).toBe("");
    expect(cfg.llm.base_url).toBe("");
    expect(cfg.llm.model).not.toMatch(/qwen|llama|mistral/i);
  });

  it("treats blank Navidrome and SUB/WAVE settings as unset", () => {
    const raw = structuredClone(exampleYamlObject);
    (raw.library as { base_url: string }).base_url = "  ";
    (raw.library as { username: string }).username = "";
    (raw.radio as { base_url: string }).base_url = "";
    (raw.radio as { admin_user: string }).admin_user = "   ";
    const cfg = parseAppConfig(raw);
    expect(cfg.library.base_url).toBe("");
    expect(cfg.library.username).toBe("");
    expect(cfg.radio.base_url).toBe("");
    expect(cfg.radio.admin_user).toBe("");
    expect(cfg.library.provider).toBe("navidrome");
    expect(cfg.radio.provider).toBe("subwave");
  });

  it("still requires a database path and data directories", () => {
    const raw = structuredClone(exampleYamlObject);
    (raw.database as { path: string }).path = "";
    expect(() => parseAppConfig(raw)).toThrow();
    const paths = structuredClone(exampleYamlObject);
    (paths.paths as { library: string }).library = "";
    expect(() => parseAppConfig(paths)).toThrow();
  });

  it("interpolates ${ENV} placeholders", () => {
    const out = interpolateEnv({ model: "${OLLAMA_MODEL}" }, { OLLAMA_MODEL: "my-local-model" });
    expect(out).toEqual({ model: "my-local-model" });
  });

  it("treats empty integration env vars as unset and does not clobber yaml", () => {
    const overridden = applyEnvOverrides(structuredClone(exampleYamlObject), {
      NAVIDROME_URL: "",
      NAVIDROME_USER: "   ",
      SUBWAVE_RADIO_URL: "",
      SUBWAVE_RADIO_ADMIN_USER: "",
      OLLAMA_BASE_URL: "",
      OLLAMA_MODEL: "  ",
    });
    expect((overridden.library as { base_url: string }).base_url).toBe("http://navidrome.example");
    expect((overridden.library as { username: string }).username).toBe("nd");
    expect((overridden.radio as { base_url: string }).base_url).toBe("http://radio.example/api");
    expect((overridden.radio as { admin_user: string }).admin_user).toBe("dj");
    expect((overridden.llm as { model: string }).model).toBe("configured-model");
    expect((overridden.llm as { base_url: string }).base_url).toBe("http://127.0.0.1:11434");
  });

  it("applies explicit env overrides without using generic PORT/HOST", () => {
    const overridden = applyEnvOverrides(structuredClone(exampleYamlObject), {
      PORT: "80",
      HOST: "0.0.0.0",
      SUBWAVE_API_PORT: "9999",
      SUBWAVE_API_HOST: "127.0.0.1",
      OLLAMA_MODEL: "from-env",
    });
    expect((overridden.server as { port: number }).port).toBe(9999);
    expect((overridden.server as { host: string }).host).toBe("127.0.0.1");
    expect((overridden.llm as { model: string }).model).toBe("from-env");
  });

  it("loads yaml + secrets dir without embedding secret values in public parse", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-cfg-"));
    const secrets = path.join(dir, "secrets");
    mkdirSync(secrets);
    writeFileSync(path.join(secrets, "admin_password"), "test-admin-secret\n");
    const cfgPath = path.join(dir, "subwave.yaml");
    writeFileSync(
      cfgPath,
      `
server:
  host: "127.0.0.1"
  port: 8788
database:
  path: "${path.join(dir, "db.sqlite")}"
paths:
  secrets_dir: "${secrets}"
  downloads: "${path.join(dir, "dl")}"
  staging: "${path.join(dir, "st")}"
  library: "${path.join(dir, "lib")}"
llm:
  base_url: "http://127.0.0.1:11434"
  model: "test-model"
library:
  base_url: "http://navidrome.example"
  username: "nd"
radio:
  base_url: "http://radio.example/api"
  admin_user: "dj"
acquisition:
  provider: slskd
  base_url: "http://slskd.example"
`,
    );
    writeFileSync(path.join(secrets, "slskd_api_key"), "super-secret-key\n");
    const loaded = loadConfig({ configPath: cfgPath });
    expect(loaded.secrets.adminPassword).toBe("test-admin-secret");
    expect(loaded.secrets.slskdApiKey).toBe("super-secret-key");
    expect(loaded.llm.model).toBe("test-model");
    expect(loaded.llm.verify_status).toBe("unverified");
    expect(loaded.library.verify_status).toBe("unverified");
    expect(loaded.radio.verify_status).toBe("unverified");
    expect(loaded.acquisition.enabled).toBe(true);
    expect(loaded.acquisition.verify_status).toBe("unverified");
    const pub = JSON.stringify(publicSettings(loaded));
    expect(publicSettings(loaded).secrets_present.slskd_api_key).toBe(true);
    expect(pub).not.toContain("super-secret-key");
  });

  it("defaults omitted llm, library, and radio verify_status to unverified", () => {
    const raw = structuredClone(exampleYamlObject);
    delete (raw.llm as { verify_status?: string }).verify_status;
    delete (raw.library as { verify_status?: string }).verify_status;
    delete (raw.radio as { verify_status?: string }).verify_status;
    const cfg = parseAppConfig(raw);
    expect(cfg.llm.verify_status).toBe("unverified");
    expect(cfg.library.verify_status).toBe("unverified");
    expect(cfg.radio.verify_status).toBe("unverified");
    const roundTrip = parseAppConfig(parseYaml(serializeAppConfig(cfg)));
    expect(roundTrip.llm.verify_status).toBe("unverified");
    expect(roundTrip.library.verify_status).toBe("unverified");
    expect(roundTrip.radio.verify_status).toBe("unverified");
    const yaml = serializeAppConfig(cfg);
    expect(yaml).not.toMatch(/verify_status/);
    expect(cfg.acquisition.verify_status).toBe("verified");
  });

  it("defaults acquisition to enabled and unverified and allows an empty URL", () => {
    const raw = structuredClone(exampleYamlObject);
    delete (raw.acquisition as { verify_status?: string }).verify_status;
    delete (raw.acquisition as { enabled?: boolean }).enabled;
    (raw.acquisition as { base_url: string }).base_url = "  ";
    const cfg = parseAppConfig(raw);
    expect(cfg.acquisition.enabled).toBe(true);
    expect(cfg.acquisition.verify_status).toBe("unverified");
    expect(cfg.acquisition.base_url).toBe("");
    expect(cfg.acquisition.provider).toBe("slskd");
  });

  it("accepts a non-slskd provider name", () => {
    const raw = structuredClone(exampleYamlObject);
    (raw.acquisition as { provider: string }).provider = "other-daemon";
    expect(parseAppConfig(raw).acquisition.provider).toBe("other-daemon");
  });

  it("persists enabled and verify_status without letting a settings patch self-verify", () => {
    const current = parseAppConfig(exampleYamlObject);
    const sameUrl = normalizeAcquisitionSettingsPatch(current.acquisition, {
      base_url: current.acquisition.base_url,
      verify_status: "verified",
      enabled: false,
    });
    expect(sameUrl.verify_status).toBeUndefined();
    expect(sameUrl.enabled).toBe(false);
    expect(normalizeAcquisitionSettingsPatch(current.acquisition, { base_url: "http://new.example" }).verify_status).toBe(
      "unverified",
    );
    expect(normalizeAcquisitionSettingsPatch(current.acquisition, {}, { apiKeyChanged: true }).verify_status).toBe(
      "unverified",
    );
    const saved = parseAppConfig({
      ...current,
      acquisition: { ...current.acquisition, enabled: false, verify_status: "unverified" as const },
    });
    const roundTrip = parseAppConfig(parseYaml(serializeAppConfig(saved)));
    expect(roundTrip.acquisition.enabled).toBe(false);
    expect(roundTrip.acquisition.verify_status).toBe("unverified");
    expect(serializeAppConfig(saved)).not.toContain("api_key");
  });

  it("defaults search selection to a 30 MiB cap, 48 kHz, 24-bit, a 1200s cap, and the version-term list", () => {
    const cfg = parseAppConfig(exampleYamlObject);
    expect(cfg.acquisition.selection.max_file_size_mb).toBe(DEFAULT_MAX_FILE_SIZE_MB);
    expect(cfg.acquisition.selection.min_file_size_mb).toBe(DEFAULT_MIN_FILE_SIZE_MB);
    expect(cfg.acquisition.selection.preferred_max_file_size_mb).toBe(DEFAULT_PREFERRED_MAX_FILE_SIZE_MB);
    expect(cfg.acquisition.selection.max_duration_seconds).toBe(DEFAULT_MAX_DURATION_SECONDS);
    expect(cfg.acquisition.selection.preferred_max_duration_seconds).toBe(DEFAULT_PREFERRED_MAX_DURATION_SECONDS);
    expect(cfg.acquisition.selection.version_preference).toBe(DEFAULT_VERSION_PREFERENCE);
    expect(cfg.acquisition.selection.format_preference).toBe(DEFAULT_FORMAT_PREFERENCE);
    expect(cfg.acquisition.selection.bitrate_floor_kbps).toBe(DEFAULT_BITRATE_FLOOR_KBPS);
    expect(cfg.acquisition.selection.short_recording_fraction).toBe(DEFAULT_SHORT_RECORDING_FRACTION);
    expect(cfg.acquisition.selection.short_recording_min_samples).toBe(DEFAULT_SHORT_RECORDING_MIN_SAMPLES);
    expect(cfg.acquisition.selection.short_recording_floor_seconds).toBe(DEFAULT_SHORT_RECORDING_FLOOR_SECONDS);
    expect(cfg.acquisition.selection.short_recording_penalty).toBe(DEFAULT_SHORT_RECORDING_PENALTY);
    expect(cfg.acquisition.selection.max_sample_rate).toBe(DEFAULT_MAX_SAMPLE_RATE);
    expect(cfg.acquisition.selection.max_bit_depth).toBe(DEFAULT_MAX_BIT_DEPTH);
    expect(cfg.acquisition.selection.version_penalty_terms).toEqual([...DEFAULT_VERSION_PENALTY_TERMS]);
    expect(cfg.acquisition.selection.extended_version_terms).toEqual([...DEFAULT_EXTENDED_VERSION_TERMS]);
    expect(cfg.acquisition.selection.long_recording_phrases).toEqual([...DEFAULT_LONG_RECORDING_PHRASES]);
    expect(cfg.acquisition.selection.instrument_part_basenames).toEqual([...DEFAULT_INSTRUMENT_PART_BASENAMES]);
    const settings = publicSettings({ ...cfg, secrets: {} }).acquisition.selection;
    expect(settings.max_file_size_mb).toBe(30);
    expect(settings.preferred_max_file_size_mb).toBe(30);
    expect(settings.min_file_size_mb).toBe(1);
    expect(settings.max_duration_seconds).toBe(1200);
    expect(settings.max_sample_rate).toBe(48000);
    expect(settings.max_bit_depth).toBe(24);
    const raw = structuredClone(exampleYamlObject);
    delete (raw.acquisition as { selection?: unknown }).selection;
    const omitted = parseAppConfig(raw);
    expect(omitted.acquisition.selection.min_file_size_mb).toBe(1);
    expect(omitted.acquisition.selection.preferred_max_file_size_mb).toBe(30);
    expect(omitted.acquisition.selection.max_duration_seconds).toBe(1200);
    expect(omitted.acquisition.selection.max_sample_rate).toBe(48000);
    expect(omitted.acquisition.selection.max_bit_depth).toBe(24);
  });

  it("applies optional slskd selection env overrides and round-trips custom selection", () => {
    const overridden = applyEnvOverrides(structuredClone(exampleYamlObject), {
      SLSKD_MAX_FILE_SIZE_MB: "150",
      SLSKD_MIN_FILE_SIZE_MB: "2",
      SLSKD_PREFERRED_MAX_FILE_SIZE_MB: "25",
      SLSKD_MAX_DURATION_SECONDS: "420",
      SLSKD_PREFERRED_MAX_DURATION_SECONDS: "300",
      SLSKD_VERSION_PREFERENCE: "radio_edit",
      SLSKD_FORMAT_PREFERENCE: "auto",
      SLSKD_EXTENDED_VERSION_BONUS: "false",
      SLSKD_LOSSLESS_PREFERENCE: "0",
      SLSKD_MAX_SAMPLE_RATE: "96000",
      SLSKD_MAX_BIT_DEPTH: "32",
    });
    const parsed = parseAppConfig(overridden);
    expect(parsed.acquisition.selection.max_file_size_mb).toBe(150);
    expect(parsed.acquisition.selection.min_file_size_mb).toBe(2);
    expect(parsed.acquisition.selection.preferred_max_file_size_mb).toBe(25);
    expect(parsed.acquisition.selection.max_duration_seconds).toBe(420);
    expect(parsed.acquisition.selection.preferred_max_duration_seconds).toBe(300);
    expect(parsed.acquisition.selection.version_preference).toBe("radio_edit");
    expect(parsed.acquisition.selection.format_preference).toBe("auto");
    expect(parsed.acquisition.selection).not.toHaveProperty("extended_version_bonus");
    expect(parsed.acquisition.selection).not.toHaveProperty("lossless_preference");
    expect(parsed.acquisition.selection.max_sample_rate).toBe(96000);
    expect(parsed.acquisition.selection.max_bit_depth).toBe(32);
    const ignored = applyEnvOverrides(structuredClone(exampleYamlObject), {
      SLSKD_MAX_FILE_SIZE_MB: "0",
      SLSKD_MIN_FILE_SIZE_MB: "0",
      SLSKD_MAX_DURATION_SECONDS: "",
      SLSKD_MAX_SAMPLE_RATE: "0",
      SLSKD_MAX_BIT_DEPTH: "",
    });
    expect((ignored.acquisition as { selection?: unknown }).selection).toBeUndefined();
    const custom = parseAppConfig({
      ...parsed,
      acquisition: {
        ...parsed.acquisition,
        selection: {
          max_file_size_mb: 150,
          max_duration_seconds: 480,
          preferred_max_duration_seconds: 400,
          max_sample_rate: 96000,
          max_bit_depth: null,
          version_penalty_terms: ["remix", "live"],
        },
      },
    });
    const roundTrip = parseAppConfig(parseYaml(serializeAppConfig(custom)));
    expect(roundTrip.acquisition.selection).toEqual({
      max_file_size_mb: 150,
      min_file_size_mb: 1,
      preferred_max_file_size_mb: DEFAULT_PREFERRED_MAX_FILE_SIZE_MB,
      max_duration_seconds: 480,
      preferred_max_duration_seconds: 400,
      version_preference: DEFAULT_VERSION_PREFERENCE,
      format_preference: DEFAULT_FORMAT_PREFERENCE,
      bitrate_floor_kbps: DEFAULT_BITRATE_FLOOR_KBPS,
      short_recording_fraction: DEFAULT_SHORT_RECORDING_FRACTION,
      short_recording_min_samples: DEFAULT_SHORT_RECORDING_MIN_SAMPLES,
      short_recording_floor_seconds: DEFAULT_SHORT_RECORDING_FLOOR_SECONDS,
      short_recording_penalty: DEFAULT_SHORT_RECORDING_PENALTY,
      max_sample_rate: 96000,
      max_bit_depth: null,
      version_penalty_terms: ["remix", "live"],
      extended_version_terms: [...DEFAULT_EXTENDED_VERSION_TERMS],
      long_recording_phrases: [...DEFAULT_LONG_RECORDING_PHRASES],
      instrument_part_basenames: [...DEFAULT_INSTRUMENT_PART_BASENAMES],
    });
    const ignoredPreferred = parseAppConfig({
      ...exampleYamlObject,
      acquisition: {
        ...exampleYamlObject.acquisition,
        selection: { preferred_max_file_size_mb: 250, max_file_size_mb: 200 },
      },
    });
    expect(ignoredPreferred.acquisition.selection.preferred_max_file_size_mb).toBe(250);
    expect(ignoredPreferred.acquisition.selection.max_file_size_mb).toBe(200);
    const hard25 = parseAppConfig({
      ...exampleYamlObject,
      acquisition: {
        ...exampleYamlObject.acquisition,
        selection: { max_file_size_mb: 25 },
      },
    });
    expect(hard25.acquisition.selection.max_file_size_mb).toBe(25);
    expect(hard25.acquisition.selection.preferred_max_file_size_mb).toBe(DEFAULT_PREFERRED_MAX_FILE_SIZE_MB);
    expect(() =>
      parseAppConfig({
        ...exampleYamlObject,
        acquisition: {
          ...exampleYamlObject.acquisition,
          selection: { preferred_max_duration_seconds: 1500, max_duration_seconds: 1200 },
        },
      }),
    ).toThrow(/preferred_max_duration_seconds/);
    expect(() =>
      parseAppConfig({
        ...exampleYamlObject,
        acquisition: {
          ...exampleYamlObject.acquisition,
          selection: { version_preference: "hip-hop" },
        },
      }),
    ).toThrow(/version_preference/);
  });

  it("ignores deprecated selector keys without translating them and names the replacement", () => {
    resetDeprecatedSelectionWarning();
    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message) => {
      warned.push(String(message));
    });
    const raw = {
      ...exampleYamlObject,
      acquisition: {
        ...exampleYamlObject.acquisition,
        selection: {
          extended_version_bonus: false,
          lossless_preference: 0,
          version_preference: "remix",
        },
      },
    };
    const parsed = parseAppConfig(raw);
    expect(parsed.acquisition.selection.version_preference).toBe("remix");
    expect(parsed.acquisition.selection.format_preference).toBe(DEFAULT_FORMAT_PREFERENCE);
    expect(parsed.acquisition.selection).not.toHaveProperty("extended_version_bonus");
    expect(parsed.acquisition.selection).not.toHaveProperty("lossless_preference");

    const onlyOld = parseAppConfig({
      ...exampleYamlObject,
      acquisition: {
        ...exampleYamlObject.acquisition,
        selection: { extended_version_bonus: false, lossless_preference: 36 },
      },
    });
    expect(onlyOld.acquisition.selection.version_preference).toBe("balanced");
    expect(onlyOld.acquisition.selection.format_preference).toBe("prefer_mp3");

    const envOnly = applyEnvOverrides(structuredClone(exampleYamlObject), {
      SLSKD_EXTENDED_VERSION_BONUS: "true",
      SLSKD_LOSSLESS_PREFERENCE: "0",
    });
    expect(parseAppConfig(envOnly).acquisition.selection.version_preference).toBe(DEFAULT_VERSION_PREFERENCE);
    expect(parseAppConfig(envOnly).acquisition.selection.format_preference).toBe(DEFAULT_FORMAT_PREFERENCE);

    const notes = selectionDeprecationNotes(raw, { SLSKD_LOSSLESS_PREFERENCE: "0" });
    expect(notes.join("\n")).toContain("extended_version_bonus is deprecated and ignored");
    expect(notes.join("\n")).toContain("acquisition.selection.version_preference");
    expect(notes.join("\n")).toContain("SLSKD_VERSION_PREFERENCE");
    expect(notes.join("\n")).toContain("lossless_preference is deprecated and ignored");
    expect(notes.join("\n")).toContain("acquisition.selection.format_preference");
    expect(notes.join("\n")).toContain("SLSKD_LOSSLESS_PREFERENCE is deprecated and ignored");
    expect(notes.join("\n")).toContain("SLSKD_FORMAT_PREFERENCE");

    const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-cfg-deprecation-"));
    const secrets = path.join(dir, "secrets");
    mkdirSync(secrets);
    writeFileSync(path.join(secrets, "admin_password"), "test-admin-secret\n");
    writeFileSync(path.join(secrets, "session_secret"), "test-session-secret\n");
    const cfgPath = path.join(dir, "subwave.yaml");
    writeFileSync(
      cfgPath,
      `
server:
  host: "127.0.0.1"
  port: 8788
database:
  path: ":memory:"
paths:
  secrets_dir: "${secrets}"
  downloads: "${path.join(dir, "downloads")}"
  staging: "${path.join(dir, "staging")}"
  library: "${path.join(dir, "library")}"
acquisition:
  selection:
    extended_version_bonus: false
    lossless_preference: 0
`,
    );
    const loaded = loadConfig({
      configPath: cfgPath,
      env: { ...process.env, SLSKD_EXTENDED_VERSION_BONUS: "false", SLSKD_LOSSLESS_PREFERENCE: "12" },
    });
    expect(loaded.acquisition.selection.version_preference).toBe("balanced");
    expect(loaded.acquisition.selection.format_preference).toBe("prefer_mp3");
    const doctorNotes = (loaded.deprecation_notes ?? []).join("\n");
    expect(doctorNotes).toContain("version_preference");
    expect(doctorNotes).toContain("format_preference");
    expect(doctorNotes).toContain("extended_version_bonus");
    expect(doctorNotes).toContain("lossless_preference");
    expect(warned.join("\n")).toContain("deprecated and ignored");
    spy.mockRestore();
  });

  it("warns when max_file_size_mb is above 30 and still loads a hard max of 25", () => {
    resetDeprecatedSelectionWarning();
    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message) => {
      warned.push(String(message));
    });
    const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-cfg-size-"));
    const secrets = path.join(dir, "secrets");
    mkdirSync(secrets);
    writeFileSync(path.join(secrets, "admin_password"), "test-admin-secret\n");
    writeFileSync(path.join(secrets, "session_secret"), "test-session-secret\n");
    const cfgPath = path.join(dir, "subwave.yaml");
    const yaml = (max: number) => `
server:
  host: "127.0.0.1"
  port: 8788
database:
  path: ":memory:"
paths:
  secrets_dir: "${secrets}"
  downloads: "${path.join(dir, "downloads")}"
  staging: "${path.join(dir, "staging")}"
  library: "${path.join(dir, "library")}"
acquisition:
  selection:
    max_file_size_mb: ${max}
    preferred_max_file_size_mb: 30
`;
    writeFileSync(cfgPath, yaml(200));
    const copied = loadConfig({ configPath: cfgPath, env: {} });
    expect(copied.acquisition.selection.max_file_size_mb).toBe(200);
    const copiedNotes = (copied.deprecation_notes ?? []).join("\n");
    expect(copiedNotes).toContain("recommended web-radio value is 30");
    expect(copiedNotes).toContain("max_file_size_mb is above 30");
    expect(warned.join("\n")).toContain("recommended web-radio value is 30");

    resetDeprecatedSelectionWarning();
    warned.length = 0;
    writeFileSync(cfgPath, yaml(30));
    const current = loadConfig({ configPath: cfgPath, env: {} });
    expect(current.acquisition.selection.max_file_size_mb).toBe(30);
    expect((current.deprecation_notes ?? []).join("\n")).not.toContain("recommended web-radio value is 30");
    expect(warned.join("\n")).not.toContain("recommended web-radio value is 30");

    resetDeprecatedSelectionWarning();
    writeFileSync(cfgPath, yaml(30));
    const fromEnv = loadConfig({ configPath: cfgPath, env: { SLSKD_MAX_FILE_SIZE_MB: "200" } });
    expect(fromEnv.acquisition.selection.max_file_size_mb).toBe(200);
    expect((fromEnv.deprecation_notes ?? []).join("\n")).toContain("recommended web-radio value is 30");

    writeFileSync(cfgPath, yaml(25));
    const tight = loadConfig({ configPath: cfgPath, env: {} });
    expect(tight.acquisition.selection.max_file_size_mb).toBe(25);
    expect(tight.acquisition.selection.preferred_max_file_size_mb).toBe(30);
    expect((tight.deprecation_notes ?? []).join("\n")).not.toContain("recommended web-radio value is 30");
    spy.mockRestore();
  });

  it("loads with Navidrome, SUB/WAVE, and Ollama empty or unset", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-cfg-empty-"));
    const secrets = path.join(dir, "secrets");
    mkdirSync(secrets);
    writeFileSync(path.join(secrets, "admin_password"), "test-admin-secret\n");
    writeFileSync(path.join(secrets, "session_secret"), "test-session-secret\n");
    writeFileSync(path.join(secrets, "navidrome_password"), "   \n");
    writeFileSync(path.join(secrets, "subwave_admin_password"), "\n");
    const cfgPath = path.join(dir, "subwave.yaml");
    writeFileSync(
      cfgPath,
      `
server:
  host: "127.0.0.1"
  port: 8788
database:
  path: "${path.join(dir, "db.sqlite")}"
paths:
  secrets_dir: "${secrets}"
  downloads: "${path.join(dir, "dl")}"
  staging: "${path.join(dir, "st")}"
  library: "${path.join(dir, "lib")}"
llm:
  base_url: "\${OLLAMA_BASE_URL}"
  model: "\${OLLAMA_MODEL}"
library:
  base_url: "\${NAVIDROME_URL}"
  username: "\${NAVIDROME_USER}"
radio:
  base_url: "\${SUBWAVE_RADIO_URL}"
  admin_user: "\${SUBWAVE_RADIO_ADMIN_USER}"
`,
    );
    const env = {
      OLLAMA_BASE_URL: "",
      OLLAMA_MODEL: "",
      NAVIDROME_URL: "",
      NAVIDROME_USER: "  ",
      SUBWAVE_RADIO_URL: "",
      SUBWAVE_RADIO_ADMIN_USER: "",
    };
    const loaded = loadConfig({ configPath: cfgPath, env });
    expect(loaded.llm.base_url).toBe("");
    expect(loaded.llm.model).toBe("");
    expect(loaded.library.base_url).toBe("");
    expect(loaded.library.username).toBe("");
    expect(loaded.radio.base_url).toBe("");
    expect(loaded.radio.admin_user).toBe("");
    expect(loaded.secrets.navidromePassword).toBeUndefined();
    expect(loaded.secrets.subwaveAdminPassword).toBeUndefined();
    expect(loaded.secrets.adminPassword).toBe("test-admin-secret");
    const status = integrationStatus(loaded);
    expect(status.llm.state).toBe("not_configured");
    expect(status.library.state).toBe("not_configured");
    expect(status.radio.state).toBe("not_configured");
    expect(status.llm.detail).toMatch(/not configured/);
    expect(status.llm.detail).not.toMatch(/unreachable/);
    expect(status.library.detail).toBe("navidrome is not configured");
    expect(status.radio.detail).toBe("subwave radio is not configured");
    expect(JSON.stringify(publicSettings(loaded))).not.toMatch(/qwen3:8b/);

    const unset = loadConfig({ configPath: cfgPath, env: {} });
    expect(unset.library.base_url).toBe("");
    expect(unset.radio.admin_user).toBe("");
    expect(integrationStatus(unset).llm.state).toBe("not_configured");
  });

  it("defaults the search-visible wait to 30 minutes and rejects a non-positive limit", () => {
    const cfg = parseAppConfig(exampleYamlObject);
    expect(cfg.radio.search_visible_timeout_ms).toBe(DEFAULT_SEARCH_VISIBLE_TIMEOUT_MS);
    expect(DEFAULT_SEARCH_VISIBLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
    const zero = structuredClone(exampleYamlObject);
    (zero.radio as { search_visible_timeout_ms?: number }).search_visible_timeout_ms = 0;
    expect(() => parseAppConfig(zero)).toThrow();
    const fraction = structuredClone(exampleYamlObject);
    (fraction.radio as { search_visible_timeout_ms?: number }).search_visible_timeout_ms = 1.5;
    expect(() => parseAppConfig(fraction)).toThrow();
    const custom = structuredClone(exampleYamlObject);
    (custom.radio as { search_visible_timeout_ms?: number }).search_visible_timeout_ms = 5_000;
    const parsed = parseAppConfig(custom);
    expect(parsed.radio.search_visible_timeout_ms).toBe(5_000);
    expect(publicSettings({ ...parsed, secrets: { adminPassword: "x" } }).radio.search_visible_timeout_ms).toBe(5_000);
    const yaml = serializeAppConfig(parsed);
    expect(yaml).toContain("search_visible_timeout_ms: 5000");
    expect(parseAppConfig(parseYaml(yaml)).radio.search_visible_timeout_ms).toBe(5_000);
    const overridden = applyEnvOverrides(structuredClone(exampleYamlObject) as Record<string, unknown>, {
      SUBWAVE_RADIO_SEARCH_VISIBLE_TIMEOUT_MS: "45000",
    });
    expect(parseAppConfig(overridden).radio.search_visible_timeout_ms).toBe(45_000);
    const ignored = applyEnvOverrides(structuredClone(exampleYamlObject) as Record<string, unknown>, {
      SUBWAVE_RADIO_SEARCH_VISIBLE_TIMEOUT_MS: "0",
    });
    expect(parseAppConfig(ignored).radio.search_visible_timeout_ms).toBe(DEFAULT_SEARCH_VISIBLE_TIMEOUT_MS);
    expect(
      fieldSourcesFor(exampleYamlObject, { SUBWAVE_RADIO_SEARCH_VISIBLE_TIMEOUT_MS: "45000" })[
        "radio.search_visible_timeout_ms"
      ],
    ).toEqual({ source: "env", env: "SUBWAVE_RADIO_SEARCH_VISIBLE_TIMEOUT_MS" });
  });

  it("defaults the download deadline, path prefix, and ffprobe path", () => {
    const cfg = parseAppConfig(exampleYamlObject);
    expect(cfg.acquisition.download_timeout_ms).toBe(DEFAULT_DOWNLOAD_TIMEOUT_MS);
    expect(DEFAULT_DOWNLOAD_TIMEOUT_MS).toBe(6 * 60 * 60 * 1000);
    expect(cfg.acquisition.downloads_path_prefix).toBe(DEFAULT_SLSKD_DOWNLOADS_DIR);
    expect(DEFAULT_SLSKD_DOWNLOADS_DIR).toBe("/downloads");
    expect(cfg.files.ffprobe_path).toBe("ffprobe");
    const zero = structuredClone(exampleYamlObject);
    (zero.acquisition as { download_timeout_ms?: number }).download_timeout_ms = 0;
    expect(() => parseAppConfig(zero)).toThrow();
    const custom = structuredClone(exampleYamlObject) as {
      acquisition: Record<string, unknown>;
      files: Record<string, unknown>;
    };
    custom.acquisition.download_timeout_ms = 5_000;
    custom.acquisition.downloads_path_prefix = "/slskd/downloads";
    custom.files.ffprobe_path = "/usr/bin/ffprobe";
    const parsed = parseAppConfig(custom);
    expect(parsed.acquisition.download_timeout_ms).toBe(5_000);
    expect(parsed.acquisition.downloads_path_prefix).toBe("/slskd/downloads");
    expect(parsed.files.ffprobe_path).toBe("/usr/bin/ffprobe");
    const pub = publicSettings({ ...parsed, secrets: { adminPassword: "x" } });
    expect(pub.acquisition.download_timeout_ms).toBe(5_000);
    expect(pub.acquisition.downloads_path_prefix).toBe("/slskd/downloads");
    expect(pub.files.ffprobe_path).toBe("/usr/bin/ffprobe");
    const yaml = serializeAppConfig(parsed);
    expect(yaml).toContain("download_timeout_ms: 5000");
    expect(yaml).toContain("downloads_path_prefix: /slskd/downloads");
    expect(yaml).toContain("ffprobe_path: /usr/bin/ffprobe");
    expect(parseAppConfig(parseYaml(yaml)).acquisition.download_timeout_ms).toBe(5_000);
    const overridden = applyEnvOverrides(structuredClone(exampleYamlObject) as Record<string, unknown>, {
      SLSKD_DOWNLOAD_TIMEOUT_MS: "45000",
      SLSKD_DOWNLOADS_PATH_PREFIX: "/data/downloads",
      SUBWAVE_FFPROBE_PATH: "ffprobe",
    });
    const fromEnv = parseAppConfig(overridden);
    expect(fromEnv.acquisition.download_timeout_ms).toBe(45_000);
    expect(fromEnv.acquisition.downloads_path_prefix).toBe("/data/downloads");
    expect(fromEnv.files.ffprobe_path).toBe("ffprobe");
    const ignored = applyEnvOverrides(structuredClone(exampleYamlObject) as Record<string, unknown>, {
      SLSKD_DOWNLOAD_TIMEOUT_MS: "0",
    });
    expect(parseAppConfig(ignored).acquisition.download_timeout_ms).toBe(DEFAULT_DOWNLOAD_TIMEOUT_MS);
  });
});

describe("classification schema", () => {
  const valid = {
    artist: "A",
    title: "T",
    genre: "techno",
    subgenres: ["minimal"],
    electronic: true,
    station_match: true,
    confidence: 0.9,
    reason: "fits the policy",
  };

  it("accepts the verified classification shape", () => {
    expect(parseClassification(valid)).toEqual(valid);
  });

  it("rejects missing fields and out-of-range confidence", () => {
    expect(safeParseClassification({ ...valid, confidence: 1.2 }).success).toBe(false);
    expect(safeParseClassification({ ...valid, artist: "" }).success).toBe(false);
    expect(() => parseClassificationJson("not json")).toThrow(/not valid JSON/);
  });
});
