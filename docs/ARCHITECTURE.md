# Architecture — Sub Wave AI Radio Automation (Amendment A3)

This repository delivers Sub Wave AI. The local clone directory and install path are always `subwave-ai`. The GitHub remote/repo name remains SmartRadio.

Ollama is **external only**. The app never installs, updates, or pulls Ollama or any model. Model names are configuration, never source defaults.

Amendment **A3** is locked below. Live host values in this document are **config examples**. They are never required application defaults and must not be hard-coded into source.

## Amendment A3 (locked)

### Live environment (examples only — never required app defaults)

| Item | Example (operator config) |
| --- | --- |
| Host | Oracle VM, **aarch64 Linux** |
| SUB/WAVE | **1.16.0** at `http://127.0.0.1:7700` with real API base path **`/api`**. Opaque `base_url` in config is therefore `http://127.0.0.1:7700/api`. |
| SUB/WAVE verified GETs | `GET /api/health` → `{"status":"on-air"}`; `GET /api/state`; `GET /api/now-playing` |
| Ollama | Remote over Tailscale: `http://100.119.17.28:11434`, **v0.34.0**. `qwen3:8b` may exist on that daemon and **must not** be hard-coded as a model name. |
| Acquisition landing / staging | `/music/downloads` |
| Final library | `/music/library` |
| Acquisition daemon | **None** on the Oracle VM today |

### Canonical pipeline (A3 semantics)

```
REQUESTED → CLASSIFYING → APPROVED | REJECTED
  → acquisition/download → /music/downloads
  → validation → /music/library
  → announce / queue through SUB/WAVE
```

Implementation status `RECEIVED` is the A3 **REQUESTED** semantic. This amendment does **not** rename the code enum. Finer worker statuses (`CHECKING_LIBRARY`, `SEARCHING`, `DOWNLOADING`, `VALIDATING`, `IMPORTING`, …) still exist as internal steps under that pipeline.

Happy-path completion is: validated file in `/music/library`, then announce/queue through SUB/WAVE. **`INDEXING` / Navidrome `startScan` is not part of the A3 happy path.** The worker may still enqueue `index_library` after import (implementation leftover); operators must not treat that as required.

### Navidrome is passive

SmartRadio does **not** manage Navidrome scanning on the happy path. Once a validated track is in `/music/library`, the existing ~1 minute Navidrome scanner discovers it.

`startScan` / `getScanStatus` and admin `POST /api/v1/admin/library/scan` remain **optional / ops-only**. They are not required for the primary workflow.

### Two semantic radio events

SmartRadio provides **event + context only**. SUB/WAVE owns DJ personality, wording, voice, station identity, and the spoken announcement. There is **no** second DJ personality or prompt system in SmartRadio.

| Event | When | Listener meaning |
| --- | --- | --- |
| `REQUEST_ACCEPTED` | Acquisition started | “song is coming” |
| `TRACK_READY` | Validated + moved into `/music/library` | “ready / on soon” |

**Notify binding = SERVER INSPECTION REQUIRED.** Do not invent a SUB/WAVE notify HTTP endpoint. Until a live server documents the path, payload, and auth, SmartRadio must not call a guessed notify URL.

Playback handoff continues to use the verified admin APIs under the opaque `/api` `base_url`:

- `GET /dj/search`
- `POST /dj/queue-track`

### Remaining acquisition gap

There is no download daemon on Oracle. `AcquisitionProvider` is **optional / disabled** until a verified service exists. `GET /api/v1/doctor` surfaces `acquire_unavailable` when acquisition is unverified, missing a URL, or missing an API key. Landing-dir config for a live host is `/music/downloads`.

## Process split

| Process | Responsibility |
| --- | --- |
| `apps/api` | Auth, CRUD, enqueue jobs, OpenAPI. Binds `127.0.0.1` by default. Does **not** call LLM/library/acquisition/radio except to persist config. |
| `apps/worker` | Claims leased jobs. Owns LLM classification, library search, optional acquisition, SUB/WAVE playback handoff, live health probes, and the file flow. Does not own DJ copy/voice. |
| `apps/web` | Vite/React operator console (same origin in production). |

SQLite (`packages/db`) persists users, sessions, settings, providers, requests, `request_events`, jobs, `job_attempts`, library matches, acquisition items, and `llm_calls` across restarts.

## Request state machine

Implementation statuses: `RECEIVED → CLASSIFYING → REJECTED|APPROVED → CHECKING_LIBRARY → ALREADY_AVAILABLE|SEARCHING → QUEUED → DOWNLOADING → DOWNLOAD_COMPLETE → VALIDATING → IMPORTING → INDEXING → READY`, plus `FAILED` and `CANCELLED`.

A3 mapping:

- `RECEIVED` = semantic `REQUESTED`
- After `APPROVED`, library check may skip download (`ALREADY_AVAILABLE`) or enter acquisition (`SEARCHING` …)
- File flow: `/music/downloads` (landing) → validation → `/music/library` (final)
- `INDEXING` is retained in the graph for the leftover `index_library` job and ops-only scans; A3 does not require it on the happy path

Rules:

- The only writer is domain code in `packages/core` (`assertTransition`) plus `packages/db` `transitionRequest`, which appends `request_events`.
- `FAILED` and `CANCELLED` are reachable from every non-terminal status.
- `FAILED` may retry back to a checkpoint (API `POST /requests/:id/retry`).
- `QUEUED → READY` is the library-hit / radio-queue path (no download). `QUEUED → DOWNLOADING` is the acquisition path (when a verified provider exists).
- File flow uses `safeJoin` path-traversal checks. Music must not live only in an ephemeral container.

## LLM vs policy

1. Worker calls `OllamaProvider.classify` → `POST {base_url}/api/chat` with `stream: false` and `format` = the classification JSON schema.
2. Response JSON is validated (`artist`, `title`, `genre`, `subgenres[]`, `electronic`, `station_match`, `confidence`, `reason`) before use.
3. **Station policy is deterministic application code** (`applyStationPolicy`). The LLM never approves tracks, never runs a shell, never writes files, and never changes config.
4. Classification is **not** a DJ personality. Radio speech stays in SUB/WAVE.

## Providers (verified endpoints only)

See `docs/INTEGRATION.md`. Adapters map 1:1:

- `LLMProvider` → `OllamaProvider` (health `GET /api/tags` or `/api/version`). Live example: Tailscale `http://100.119.17.28:11434` v0.34.0 — configure, do not hard-code. No default model name.
- `MusicLibraryProvider` → `NavidromeProvider` (Subsonic 1.16.1 `{url}/rest`, `f=json`, `u` + `t/s` md5; happy-path `search3`, `getSong`; **ops-only** `startScan`, `getScanStatus`; string IDs). Navidrome is passive after files land in the library.
- `RadioProvider` → `SubWaveProvider` (opaque `base_url`; live example `http://127.0.0.1:7700/api`; public `GET /health` → `{"status":"on-air"}`, `GET /state`, `GET /now-playing`; playback `GET /dj/search` + `POST /dj/queue-track`; also `POST /dj/refresh-playlist`; public `POST /request` is secondary). `REQUEST_ACCEPTED` / `TRACK_READY` notify = **NEEDS_SERVER_INSPECTION**.
- `AcquisitionProvider` → `SoulseekProvider` only when a verified slskd exists (`/api/v0`, `X-API-Key`, `POST /searches`, `POST /transfers/downloads/{user}`, poll transfers). Otherwise leave unverified / disabled; doctor reports `acquire_unavailable`.

Unverified adapters set `verifyStatus` and **do not** call live endpoints with invented paths. Webhook / notify payload schema is `needs_server_inspection` and is not implemented.

## Config and secrets

YAML (`config/subwave.yaml`) + env interpolation/overrides + `secrets/` files. No hard-coded production IPs, passwords, API keys, ports, model names, or library paths in source. Oracle paths `/music/downloads` and `/music/library`, Tailscale Ollama, and SUB/WAVE `:7700/api` belong in **operator config**, not required defaults.

## API (`/api/v1`)

- Auth: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` (cookie or Bearer)
- Requests: CRUD list/get, events, cancel, retry
- Ops: `/health`, `/ready`, `/doctor` (includes `acquire_unavailable`), OpenAPI at `/openapi.json` and `/docs`
- `GET /providers`, `GET|PUT /settings`, `GET /admin/jobs`
- Setup/ops (Phase 4): `GET|POST /setup`, `GET /ops/overview`, `/ops/disk`, `/ops/logs`
- Admin enqueue: **ops-only** Navidrome scan, health probe, radio `refresh_playlist`

Creating a request inserts `RECEIVED` (semantic `REQUESTED`) and enqueues `classify`. The worker advances the machine.

## Production packaging

Root `install.sh` / `update.sh` / `uninstall.sh` / `backup.sh` / `restore.sh` / `doctor.sh` plus `deploy/`. Ollama is never installed. This repository does not deploy to Oracle. See `docs/DEPLOY.md` and `docs/RELEASE_CANDIDATE.md`.
