-- Sub Wave AI persistence. Music files are NOT stored in this database.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  verify_status TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_health_json TEXT,
  last_health_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  raw_query TEXT NOT NULL,
  artist TEXT,
  title TEXT,
  genre TEXT,
  status TEXT NOT NULL,
  classification_json TEXT,
  policy_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS request_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  request_id TEXT REFERENCES requests(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  payload_json TEXT,
  result_json TEXT,
  error TEXT,
  lease_until INTEGER,
  leased_by TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  success INTEGER,
  error TEXT,
  log TEXT
);

CREATE TABLE IF NOT EXISTS library_matches (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  provider_id TEXT,
  song_id TEXT NOT NULL,
  artist TEXT,
  title TEXT,
  path TEXT,
  score REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS acquisition_items (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  provider_id TEXT,
  remote_user TEXT,
  filename TEXT,
  status TEXT NOT NULL,
  progress REAL,
  local_path TEXT,
  staging_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id TEXT PRIMARY KEY,
  request_id TEXT REFERENCES requests(id) ON DELETE SET NULL,
  provider_id TEXT,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  response_json TEXT,
  parsed_ok INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_request_events_request ON request_events(request_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, run_after, lease_until);
CREATE INDEX IF NOT EXISTS idx_jobs_request ON jobs(request_id);
CREATE INDEX IF NOT EXISTS idx_llm_calls_request ON llm_calls(request_id);
