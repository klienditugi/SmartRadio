# Architecture — Sub Wave AI Radio Automation (backend foundation)

This repository delivers the **backend foundation** for Sub Wave AI. The product tree name is `subwave-ai`. The Git remote may still be named SmartRadio.

Ollama is **external only**. The app never installs, updates, or pulls Ollama or any model. Model names are configuration, never source defaults.

## Process split

| Process | Responsibility |
| --- | --- |
| `apps/api` | Auth, CRUD, enqueue jobs, OpenAPI. Binds `127.0.0.1` by default. Does **not** call LLM/library/acquisition/radio except to persist config. |
| `apps/worker` | Claims leased jobs. Owns LLM classification, Navidrome, slskd, SUB/WAVE, live health probes, and the file flow. |
| `apps/web` | Placeholder. Bot4 owns the React UI. |

SQLite (`packages/db`) persists users, sessions, settings, providers, requests, `request_events`, jobs, `job_attempts`, library matches, acquisition items, and `llm_calls` across restarts.

## Request state machine

Exact statuses: `RECEIVED → CLASSIFYING → REJECTED|APPROVED → CHECKING_LIBRARY → ALREADY_AVAILABLE|SEARCHING → QUEUED → DOWNLOADING → DOWNLOAD_COMPLETE → VALIDATING → IMPORTING → INDEXING → READY`, plus `FAILED` and `CANCELLED`.

Rules:

- The only writer is domain code in `packages/core` (`assertTransition`) plus `packages/db` `transitionRequest`, which appends `request_events`.
- `FAILED` and `CANCELLED` are reachable from every non-terminal status.
- `FAILED` may retry back to a checkpoint (API `POST /requests/:id/retry`).
- `QUEUED → READY` is the library-hit / radio-queue path (no download). `QUEUED → DOWNLOADING` is the acquisition path.
- File flow is `downloads → staging → validation → music library` with `safeJoin` path-traversal checks. Music must not live only in an ephemeral container.

## LLM vs policy

1. Worker calls `OllamaProvider.classify` → `POST {base_url}/api/chat` with `stream: false` and `format` = the classification JSON schema.
2. Response JSON is validated (`artist`, `title`, `genre`, `subgenres[]`, `electronic`, `station_match`, `confidence`, `reason`) before use.
3. **Station policy is deterministic application code** (`applyStationPolicy`). The LLM never approves tracks, never runs a shell, never writes files, and never changes config.

## Providers (verified endpoints only)

See `docs/INTEGRATION.md`. Adapters map 1:1:

- `LLMProvider` → `OllamaProvider` (health `GET /api/tags` or `/api/version`)
- `MusicLibraryProvider` → `NavidromeProvider` (Subsonic 1.16.1 `{url}/rest`, `f=json`, `u` + `t/s` md5; `search3`, `getSong`, `startScan`, `getScanStatus`; string IDs)
- `RadioProvider` → `SubWaveProvider` (opaque `base_url`; automation uses admin Basic `GET /dj/search` + `POST /dj/queue-track`; also `/health`, `/now-playing`, `/state`; public `POST /request` is secondary)
- `AcquisitionProvider` → `SoulseekProvider` (slskd only: `/api/v0`, `X-API-Key`, `POST /searches`, `POST /transfers/downloads/{user}`, poll transfers)

Unverified adapters set `verifyStatus` and **do not** call live endpoints with invented paths. Webhook payload schema is `needs_server_inspection` and is not implemented.

## Config and secrets

YAML (`config/subwave.yaml`) + env interpolation/overrides + `secrets/` files. No hard-coded production IPs, passwords, API keys, ports, or library paths in source.

## API (`/api/v1`)

- Auth: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` (cookie or Bearer)
- Requests: CRUD list/get, events, cancel, retry
- Ops: `/health`, `/ready`, `/doctor`, OpenAPI at `/openapi.json` and `/docs`
- `GET /providers`, `GET|PUT /settings`, `GET /admin/jobs`

Creating a request inserts `RECEIVED` and enqueues `classify`. The worker advances the machine.

## What Bot4 still owns

- Full React UI in `apps/web`
- Production `install.sh` (install, systemd, nginx, update, backup/restore, interactive doctor)
- First-run wizard and operator UX around provider credentials
- Any live OpenAPI import from a running SUB/WAVE (`GET /api/connect/openapi.json` is admin-gated on the radio, not copied here)
