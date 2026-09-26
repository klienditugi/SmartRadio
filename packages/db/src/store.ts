import { randomUUID } from "node:crypto";
import { assertTransition, assertCancellable } from "@subwave-ai/core";
import type { JobStatus, JobType, RequestStatus, UserRole, VerifyStatus } from "@subwave-ai/shared";
import type { Db } from "./client.js";

export type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
  created_at: number;
  updated_at: number;
};

export type SessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: number;
  created_at: number;
};

export type RequestRow = {
  id: string;
  user_id: string | null;
  raw_query: string;
  artist: string | null;
  title: string | null;
  genre: string | null;
  status: RequestStatus;
  classification_json: string | null;
  policy_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export type RequestEventRow = {
  id: string;
  request_id: string;
  from_status: RequestStatus;
  to_status: RequestStatus;
  actor: string;
  payload_json: string | null;
  created_at: number;
};

export type JobRow = {
  id: string;
  type: JobType;
  request_id: string | null;
  status: JobStatus;
  payload_json: string | null;
  result_json: string | null;
  error: string | null;
  lease_until: number | null;
  leased_by: string | null;
  attempts: number;
  max_attempts: number;
  run_after: number;
  created_at: number;
  updated_at: number;
};

export function now(): number {
  return Date.now();
}

export function insertUser(
  db: Db,
  input: { username: string; passwordHash: string; role: UserRole },
): UserRow {
  const ts = now();
  const row: UserRow = {
    id: randomUUID(),
    username: input.username,
    password_hash: input.passwordHash,
    role: input.role,
    created_at: ts,
    updated_at: ts,
  };
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
     VALUES (@id, @username, @password_hash, @role, @created_at, @updated_at)`,
  ).run(row);
  return row;
}

export function findUserByUsername(db: Db, username: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
}

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function countUsers(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  return row.n;
}

export function createSession(
  db: Db,
  input: { userId: string; tokenHash: string; expiresAt: number },
): SessionRow {
  const row: SessionRow = {
    id: randomUUID(),
    user_id: input.userId,
    token_hash: input.tokenHash,
    expires_at: input.expiresAt,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES (@id, @user_id, @token_hash, @expires_at, @created_at)`,
  ).run(row);
  return row;
}

export function findSessionByTokenHash(db: Db, tokenHash: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as SessionRow | undefined;
}

export function deleteSessionByTokenHash(db: Db, tokenHash: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function deleteExpiredSessions(db: Db, ts = now()): void {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(ts);
}

export function createRequest(
  db: Db,
  input: { userId?: string; rawQuery: string },
): RequestRow {
  const ts = now();
  const row: RequestRow = {
    id: randomUUID(),
    user_id: input.userId ?? null,
    raw_query: input.rawQuery,
    artist: null,
    title: null,
    genre: null,
    status: "RECEIVED",
    classification_json: null,
    policy_json: null,
    error: null,
    created_at: ts,
    updated_at: ts,
  };
  db.prepare(
    `INSERT INTO requests (id, user_id, raw_query, artist, title, genre, status, classification_json, policy_json, error, created_at, updated_at)
     VALUES (@id, @user_id, @raw_query, @artist, @title, @genre, @status, @classification_json, @policy_json, @error, @created_at, @updated_at)`,
  ).run(row);
  appendRequestEvent(db, {
    requestId: row.id,
    from: "RECEIVED",
    to: "RECEIVED",
    actor: "api",
    payload: { created: true },
  });
  return row;
}

export function getRequest(db: Db, id: string): RequestRow | undefined {
  return db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as RequestRow | undefined;
}

export function listRequests(db: Db, limit = 50, status?: RequestStatus): RequestRow[] {
  if (status) {
    return db
      .prepare("SELECT * FROM requests WHERE status = ? ORDER BY created_at DESC LIMIT ?")
      .all(status, limit) as RequestRow[];
  }
  return db.prepare("SELECT * FROM requests ORDER BY created_at DESC LIMIT ?").all(limit) as RequestRow[];
}

export function appendRequestEvent(
  db: Db,
  input: {
    requestId: string;
    from: RequestStatus;
    to: RequestStatus;
    actor: string;
    payload?: unknown;
  },
): RequestEventRow {
  const row: RequestEventRow = {
    id: randomUUID(),
    request_id: input.requestId,
    from_status: input.from,
    to_status: input.to,
    actor: input.actor,
    payload_json: input.payload === undefined ? null : JSON.stringify(input.payload),
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO request_events (id, request_id, from_status, to_status, actor, payload_json, created_at)
     VALUES (@id, @request_id, @from_status, @to_status, @actor, @payload_json, @created_at)`,
  ).run(row);
  return row;
}

export function listRequestEvents(db: Db, requestId: string): RequestEventRow[] {
  return db
    .prepare("SELECT * FROM request_events WHERE request_id = ? ORDER BY created_at ASC")
    .all(requestId) as RequestEventRow[];
}

export function transitionRequest(
  db: Db,
  input: {
    requestId: string;
    to: RequestStatus;
    actor: string;
    payload?: unknown;
    patch?: Partial<Pick<RequestRow, "artist" | "title" | "genre" | "classification_json" | "policy_json" | "error">>;
  },
): RequestRow {
  const existing = getRequest(db, input.requestId);
  if (!existing) throw new Error(`request not found: ${input.requestId}`);
  if (existing.status !== input.to) {
    if (input.to === "CANCELLED") {
      assertCancellable(existing.status);
    } else {
      assertTransition(existing.status, input.to);
    }
  }
  const ts = now();
  const next: RequestRow = {
    ...existing,
    ...input.patch,
    status: input.to,
    updated_at: ts,
  };
  db.prepare(
    `UPDATE requests
     SET status = @status, artist = @artist, title = @title, genre = @genre,
         classification_json = @classification_json, policy_json = @policy_json,
         error = @error, updated_at = @updated_at
     WHERE id = @id`,
  ).run(next);
  if (existing.status !== input.to) {
    appendRequestEvent(db, {
      requestId: existing.id,
      from: existing.status,
      to: input.to,
      actor: input.actor,
      payload: input.payload,
    });
  }
  return next;
}

export function enqueueJob(
  db: Db,
  input: { type: JobType; requestId?: string; payload?: unknown; maxAttempts?: number; runAfter?: number },
): JobRow {
  const ts = now();
  const row: JobRow = {
    id: randomUUID(),
    type: input.type,
    request_id: input.requestId ?? null,
    status: "queued",
    payload_json: input.payload === undefined ? null : JSON.stringify(input.payload),
    result_json: null,
    error: null,
    lease_until: null,
    leased_by: null,
    attempts: 0,
    max_attempts: input.maxAttempts ?? 5,
    run_after: input.runAfter ?? ts,
    created_at: ts,
    updated_at: ts,
  };
  db.prepare(
    `INSERT INTO jobs (id, type, request_id, status, payload_json, result_json, error, lease_until, leased_by, attempts, max_attempts, run_after, created_at, updated_at)
     VALUES (@id, @type, @request_id, @status, @payload_json, @result_json, @error, @lease_until, @leased_by, @attempts, @max_attempts, @run_after, @created_at, @updated_at)`,
  ).run(row);
  return row;
}

export function getJob(db: Db, id: string): JobRow | undefined {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
}

export function listJobs(db: Db, limit = 100): JobRow[] {
  return db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit) as JobRow[];
}

export function listJobsForRequest(db: Db, requestId: string): JobRow[] {
  return db.prepare("SELECT * FROM jobs WHERE request_id = ? ORDER BY created_at ASC").all(requestId) as JobRow[];
}

/**
 * Claim the oldest runnable job with a lease. Expired running leases are reclaimable.
 */
export function claimJob(db: Db, workerId: string, leaseMs: number, ts = now()): JobRow | null {
  const claim = db.transaction((): JobRow | null => {
    const row = db
      .prepare(
        `SELECT * FROM jobs
         WHERE attempts < max_attempts
           AND run_after <= ?
           AND (
             status = 'queued'
             OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < ?)
           )
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(ts, ts) as JobRow | undefined;
    if (!row) return null;
    const leaseUntil = ts + leaseMs;
    db.prepare(
      `UPDATE jobs
       SET status = 'running', leased_by = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?, error = NULL
       WHERE id = ?`,
    ).run(workerId, leaseUntil, ts, row.id);
    db.prepare(
      `INSERT INTO job_attempts (id, job_id, started_at) VALUES (?, ?, ?)`,
    ).run(randomUUID(), row.id, ts);
    return getJob(db, row.id) ?? null;
  });
  return claim();
}

export function completeJob(
  db: Db,
  input: { jobId: string; success: boolean; result?: unknown; error?: string; retryDelayMs?: number },
): JobRow {
  const ts = now();
  const job = getJob(db, input.jobId);
  if (!job) throw new Error(`job not found: ${input.jobId}`);
  const attempt = db
    .prepare(
      `SELECT id FROM job_attempts WHERE job_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    )
    .get(job.id) as { id: string } | undefined;
  if (attempt) {
    db.prepare(
      `UPDATE job_attempts SET finished_at = ?, success = ?, error = ? WHERE id = ?`,
    ).run(ts, input.success ? 1 : 0, input.error ?? null, attempt.id);
  }
  if (input.success) {
    db.prepare(
      `UPDATE jobs SET status = 'succeeded', result_json = ?, error = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
    ).run(input.result === undefined ? null : JSON.stringify(input.result), ts, job.id);
  } else if (job.attempts >= job.max_attempts) {
    db.prepare(
      `UPDATE jobs SET status = 'failed', error = ?, lease_until = NULL, updated_at = ? WHERE id = ?`,
    ).run(input.error ?? "job failed", ts, job.id);
  } else {
    const runAfter = ts + (input.retryDelayMs ?? 1_000 * job.attempts);
    db.prepare(
      `UPDATE jobs SET status = 'queued', error = ?, lease_until = NULL, leased_by = NULL, run_after = ?, updated_at = ? WHERE id = ?`,
    ).run(input.error ?? "job failed", runAfter, ts, job.id);
  }
  const next = getJob(db, job.id);
  if (!next) throw new Error("job missing after complete");
  return next;
}

export function cancelJobsForRequest(db: Db, requestId: string): void {
  db.prepare(
    `UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE request_id = ? AND status IN ('queued', 'running')`,
  ).run(now(), requestId);
}

export function upsertProvider(
  db: Db,
  input: {
    id: string;
    kind: string;
    name: string;
    config: unknown;
    verifyStatus: VerifyStatus;
    enabled?: boolean;
  },
): void {
  const ts = now();
  db.prepare(
    `INSERT INTO providers (id, kind, name, config_json, verify_status, enabled, created_at, updated_at)
     VALUES (@id, @kind, @name, @config_json, @verify_status, @enabled, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       name = excluded.name,
       config_json = excluded.config_json,
       verify_status = excluded.verify_status,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  ).run({
    id: input.id,
    kind: input.kind,
    name: input.name,
    config_json: JSON.stringify(input.config),
    verify_status: input.verifyStatus,
    enabled: input.enabled === false ? 0 : 1,
    created_at: ts,
    updated_at: ts,
  });
}

export function listProviders(db: Db) {
  return db.prepare("SELECT * FROM providers ORDER BY kind").all();
}

export function updateProviderHealth(db: Db, id: string, health: unknown): void {
  db.prepare("UPDATE providers SET last_health_json = ?, last_health_at = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(health),
    now(),
    now(),
    id,
  );
}

export type IntegrationCheck = {
  integration: string;
  state: string;
  fingerprint: string;
  testedAt: number;
};

type IntegrationCheckRow = {
  integration: string;
  state: string;
  fingerprint: string;
  tested_at: number;
};

function mapIntegrationCheck(row: IntegrationCheckRow): IntegrationCheck {
  return {
    integration: row.integration,
    state: row.state,
    fingerprint: row.fingerprint,
    testedAt: row.tested_at,
  };
}

export function upsertIntegrationCheck(
  db: Db,
  input: { integration: string; state: string; fingerprint: string; testedAt: number },
): void {
  db.prepare(
    `INSERT INTO integration_checks (integration, state, fingerprint, tested_at)
     VALUES (@integration, @state, @fingerprint, @tested_at)
     ON CONFLICT(integration) DO UPDATE SET
       state = excluded.state,
       fingerprint = excluded.fingerprint,
       tested_at = excluded.tested_at`,
  ).run({
    integration: input.integration,
    state: input.state,
    fingerprint: input.fingerprint,
    tested_at: input.testedAt,
  });
}

export function listIntegrationChecks(db: Db): IntegrationCheck[] {
  const rows = db.prepare("SELECT integration, state, fingerprint, tested_at FROM integration_checks ORDER BY integration").all() as IntegrationCheckRow[];
  return rows.map(mapIntegrationCheck);
}

export function getSetting(db: Db, key: string): unknown {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
  return row ? JSON.parse(row.value_json) : undefined;
}

export function putSetting(db: Db, key: string, value: unknown, updatedBy?: string): void {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(key, JSON.stringify(value), now(), updatedBy ?? null);
}

export function listSettings(db: Db): Record<string, unknown> {
  const rows = db.prepare("SELECT key, value_json FROM settings").all() as { key: string; value_json: string }[];
  const out: Record<string, unknown> = {};
  for (const row of rows) out[row.key] = JSON.parse(row.value_json);
  return out;
}

export function recordLlmCall(
  db: Db,
  input: {
    requestId?: string;
    providerId?: string;
    model: string;
    prompt: string;
    response?: unknown;
    parsedOk: boolean;
    latencyMs?: number;
    error?: string;
  },
): void {
  db.prepare(
    `INSERT INTO llm_calls (id, request_id, provider_id, model, prompt, response_json, parsed_ok, latency_ms, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.requestId ?? null,
    input.providerId ?? null,
    input.model,
    input.prompt,
    input.response === undefined ? null : JSON.stringify(input.response),
    input.parsedOk ? 1 : 0,
    input.latencyMs ?? null,
    input.error ?? null,
    now(),
  );
}

export function insertLibraryMatch(
  db: Db,
  input: {
    requestId: string;
    providerId?: string;
    songId: string;
    artist?: string;
    title?: string;
    path?: string;
    score?: number;
  },
): void {
  db.prepare(
    `INSERT INTO library_matches (id, request_id, provider_id, song_id, artist, title, path, score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.requestId,
    input.providerId ?? null,
    String(input.songId),
    input.artist ?? null,
    input.title ?? null,
    input.path ?? null,
    input.score ?? null,
    now(),
  );
}

export function insertAcquisitionItem(
  db: Db,
  input: {
    requestId: string;
    providerId?: string;
    remoteUser?: string;
    filename?: string;
    status: string;
    progress?: number;
    localPath?: string;
    stagingPath?: string;
  },
): string {
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO acquisition_items (id, request_id, provider_id, remote_user, filename, status, progress, local_path, staging_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.requestId,
    input.providerId ?? null,
    input.remoteUser ?? null,
    input.filename ?? null,
    input.status,
    input.progress ?? null,
    input.localPath ?? null,
    input.stagingPath ?? null,
    ts,
    ts,
  );
  return id;
}

export type AcquisitionItemRow = {
  id: string;
  request_id: string;
  provider_id: string | null;
  remote_user: string | null;
  filename: string | null;
  status: string;
  progress: number | null;
  local_path: string | null;
  staging_path: string | null;
  created_at: number;
  updated_at: number;
};

export function listAcquisitionItems(db: Db, requestId?: string, limit = 100): AcquisitionItemRow[] {
  if (requestId) {
    return db
      .prepare("SELECT * FROM acquisition_items WHERE request_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(requestId, limit) as AcquisitionItemRow[];
  }
  return db
    .prepare("SELECT * FROM acquisition_items ORDER BY created_at DESC LIMIT ?")
    .all(limit) as AcquisitionItemRow[];
}

export function updateAcquisitionItem(
  db: Db,
  id: string,
  patch: Partial<
    Pick<AcquisitionItemRow, "status" | "progress" | "remote_user" | "filename" | "local_path" | "staging_path">
  >,
): void {
  const existing = db.prepare("SELECT * FROM acquisition_items WHERE id = ?").get(id) as AcquisitionItemRow | undefined;
  if (!existing) throw new Error(`acquisition item not found: ${id}`);
  const next = {
    ...existing,
    ...patch,
    updated_at: now(),
  };
  db.prepare(
    `UPDATE acquisition_items
     SET status = @status, progress = @progress, remote_user = @remote_user, filename = @filename,
         local_path = @local_path, staging_path = @staging_path, updated_at = @updated_at
     WHERE id = @id`,
  ).run(next);
}

export type LibraryMatchRow = {
  id: string;
  request_id: string;
  provider_id: string | null;
  song_id: string;
  artist: string | null;
  title: string | null;
  path: string | null;
  score: number | null;
  created_at: number;
};

export function listLibraryMatches(db: Db, requestId: string): LibraryMatchRow[] {
  return db
    .prepare("SELECT * FROM library_matches WHERE request_id = ? ORDER BY created_at DESC")
    .all(requestId) as LibraryMatchRow[];
}

export type LlmCallRow = {
  id: string;
  request_id: string | null;
  provider_id: string | null;
  model: string;
  prompt: string;
  response_json: string | null;
  parsed_ok: number;
  latency_ms: number | null;
  error: string | null;
  created_at: number;
};

export function listLlmCalls(db: Db, opts: { requestId?: string; limit?: number; errorsOnly?: boolean } = {}): LlmCallRow[] {
  const limit = opts.limit ?? 100;
  if (opts.requestId) {
    return db
      .prepare("SELECT * FROM llm_calls WHERE request_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(opts.requestId, limit) as LlmCallRow[];
  }
  if (opts.errorsOnly) {
    return db
      .prepare("SELECT * FROM llm_calls WHERE error IS NOT NULL OR parsed_ok = 0 ORDER BY created_at DESC LIMIT ?")
      .all(limit) as LlmCallRow[];
  }
  return db.prepare("SELECT * FROM llm_calls ORDER BY created_at DESC LIMIT ?").all(limit) as LlmCallRow[];
}

export type JobAttemptRow = {
  id: string;
  job_id: string;
  started_at: number;
  finished_at: number | null;
  success: number | null;
  error: string | null;
  log: string | null;
};

export function listJobAttempts(db: Db, jobId?: string, limit = 100): JobAttemptRow[] {
  if (jobId) {
    return db
      .prepare("SELECT * FROM job_attempts WHERE job_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(jobId, limit) as JobAttemptRow[];
  }
  return db
    .prepare("SELECT * FROM job_attempts ORDER BY started_at DESC LIMIT ?")
    .all(limit) as JobAttemptRow[];
}

export function listRecentRequestEvents(db: Db, limit = 100): RequestEventRow[] {
  return db.prepare("SELECT * FROM request_events ORDER BY created_at DESC LIMIT ?").all(limit) as RequestEventRow[];
}

export function listJobsWithErrors(db: Db, limit = 100): JobRow[] {
  return db
    .prepare(
      `SELECT * FROM jobs
       WHERE error IS NOT NULL OR status IN ('failed')
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as JobRow[];
}

export function countRequestsByStatus(db: Db): Record<string, number> {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM requests GROUP BY status").all() as {
    status: string;
    n: number;
  }[];
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = row.n;
  return out;
}

export function countJobsByStatus(db: Db): Record<string, number> {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as {
    status: string;
    n: number;
  }[];
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = row.n;
  return out;
}

export function cancelJob(db: Db, jobId: string): JobRow | undefined {
  const job = getJob(db, jobId);
  if (!job) return undefined;
  if (job.status !== "queued" && job.status !== "running") return job;
  db.prepare("UPDATE jobs SET status = 'cancelled', lease_until = NULL, updated_at = ? WHERE id = ?").run(now(), jobId);
  return getJob(db, jobId);
}
