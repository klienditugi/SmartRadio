-- Stored test-connection results. verify_status in yaml/env is not a source of truth.
-- fingerprint is a hash of the config that was tested, including a hash of the secret, never the secret.

CREATE TABLE IF NOT EXISTS integration_checks (
  integration TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  tested_at INTEGER NOT NULL
);
