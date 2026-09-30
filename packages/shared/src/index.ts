export {
  REQUEST_STATUSES,
  TERMINAL_STATUSES,
  isRequestStatus,
  isTerminalStatus,
  JOB_TYPES,
  JOB_STATUSES,
  PROVIDER_KINDS,
  VERIFY_STATUSES,
  ACQUISITION_CONNECTION_STATES,
  INTEGRATION_CONNECTION_STATES,
  NAVIDROME_NOT_CONFIGURED,
  SUBWAVE_RADIO_NOT_CONFIGURED,
  ollamaNotConfiguredDetail,
  describeIntegration,
  USER_ROLES,
} from "./status.js";
export type {
  RequestStatus,
  JobType,
  JobStatus,
  ProviderKind,
  VerifyStatus,
  AcquisitionConnectionState,
  IntegrationConnectionState,
  IntegrationReport,
  UserRole,
} from "./status.js";

export {
  classificationSchema,
  CLASSIFICATION_JSON_SCHEMA,
  parseClassification,
  safeParseClassification,
  parseClassificationJson,
} from "./classification.js";
export type { Classification } from "./classification.js";

export { PathTraversalError, assertInsideRoot, safeJoin, isAllowedAudioExtension } from "./paths.js";

export { SECRET_FILES, loadSecrets, readSecretFile, writeSecretFile } from "./secrets.js";
export type { LoadedSecrets } from "./secrets.js";

export {
  stationPolicySchema,
  appConfigSchema,
  DEFAULT_MAX_FILE_SIZE_MB,
  DEFAULT_MIN_FILE_SIZE_MB,
  DEFAULT_PREFERRED_MAX_FILE_SIZE_MB,
  DEFAULT_MAX_SAMPLE_RATE,
  DEFAULT_MAX_BIT_DEPTH,
  DEFAULT_MAX_DURATION_SECONDS,
  DEFAULT_PREFERRED_MAX_DURATION_SECONDS,
  VERSION_PREFERENCES,
  DEFAULT_VERSION_PREFERENCE,
  FORMAT_PREFERENCES,
  DEFAULT_FORMAT_PREFERENCE,
  DEFAULT_BITRATE_FLOOR_KBPS,
  DEFAULT_SHORT_RECORDING_FRACTION,
  DEFAULT_SHORT_RECORDING_MIN_SAMPLES,
  DEFAULT_SHORT_RECORDING_FLOOR_SECONDS,
  DEFAULT_SEARCH_VISIBLE_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_SLSKD_DOWNLOADS_DIR,
  DEFAULT_SHORT_RECORDING_PENALTY,
  DEFAULT_VERSION_PENALTY_TERMS,
  DEFAULT_INSTRUMENT_PART_BASENAMES,
  DEFAULT_EXTENDED_VERSION_TERMS,
  DEFAULT_LONG_RECORDING_PHRASES,
  CONFIGURED_UNVERIFIED_MESSAGE,
  warnDeprecatedVerifyStatus,
  resetDeprecatedVerifyStatusWarning,
  selectionDeprecationNotes,
  warnDeprecatedSelection,
  resetDeprecatedSelectionWarning,
  readVerifyStatusExplicit,
  integrationIsConfigured,
  isConfiguredUnverified,
  assertSettingsDoNotVerify,
  clearIntegrationVerifyOnChange,
  interpolateEnv,
  applyEnvOverrides,
  parseAppConfig,
  loadConfig,
  publicSettings,
  serializeAppConfig,
  writeAppConfig,
  mergeAppConfigPatch,
  normalizeAcquisitionSettingsPatch,
  writableConfigPath,
  isOllamaConfigured,
  isNavidromeConfigured,
  isSubwaveRadioConfigured,
  integrationStatus,
} from "./config.js";
export type {
  StationPolicy,
  AppConfig,
  RuntimeConfig,
  LoadConfigOptions,
  AcquisitionSettingsPatch,
  AppConfigPatch,
  CoreIntegration,
  VerifyStatusExplicit,
  IntegrationStatusMap,
  VersionPreference,
  FormatPreference,
} from "./config.js";

export { assertEnvPinnedUnchanged, EnvPinnedError, fieldSourcesFor } from "./field-source.js";
export type { FieldSource, FieldSources, SettingSource } from "./field-source.js";

export {
  VERIFY_STATUS_WRITE_REJECTED,
  VerifyStatusWriteError,
  assertNoVerifyStatusKey,
  containsVerifyStatusKey,
  omitVerifyStatusKeys,
} from "./verify-status-write.js";

export {
  INTEGRATION_NAMES,
  integrationConfigFingerprint,
  findMatchingIntegrationCheck,
  applyStoredVerification,
} from "./verification.js";
export type { IntegrationName, StoredIntegrationCheck } from "./verification.js";
