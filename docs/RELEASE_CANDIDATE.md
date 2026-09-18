# Release candidate — Phase 4 (web UI + ops) + Amendment A3

This branch adds the operator UI, production installer, and Compose/systemd packaging on top of the Bot2 backend foundation. Amendment **A3** locks live-environment examples, a passive Navidrome happy path, two semantic radio events, and the remaining acquisition gap. A3 is a **documentation lock**; it does not deploy to Oracle and does not invent SUB/WAVE notify APIs.

## What is in

- Responsive Vite/React console (`apps/web`) consuming `/api/v1`
- First-run / settings wizard (no hard-coded production IPs, credentials, ports, or model names — including no hard-coded `qwen3:8b`)
- Dashboard, request/job queue with canonical states, download progress snapshot, errors/logs, disk
- Auth + admin actions: retry, cancel, approve, reject, reclassify, retry acquisition, **ops-only** Navidrome scan, radio playlist refresh (enqueue-only). `REJECTED → APPROVED` is labeled in the UI as an **operator override that skips reclassification**.
- Root `install.sh`, `update.sh`, `uninstall.sh`, `backup.sh`, `restore.sh`, `doctor.sh`
- `deploy/docker-compose.yml` + `deploy/Dockerfile` with **host-mounted** data and library
- Tests for API extras, progress extraction, UI helpers, ops script contracts
- Doctor field `acquire_unavailable` when acquisition is unverified / unconfigured (no download daemon on Oracle)

Clone story remains (GitHub remote/repo: SmartRadio; local directory: **`subwave-ai`**):

```bash
git clone <repo-url> subwave-ai
cd subwave-ai
sudo ./install.sh
```

Ollama is never installed, updated, or pulled.

## Amendment A3 lock

Canonical pipeline (semantic):

`REQUESTED` → `CLASSIFYING` → `APPROVED`/`REJECTED` → acquisition/download → `/music/downloads` → validation → `/music/library` → announce/queue through SUB/WAVE

- Implementation status `RECEIVED` = semantic `REQUESTED` (not renamed in code).
- **Navidrome is passive.** SmartRadio does not trigger scans on the happy path. After a validated file is in `/music/library`, Navidrome’s existing ~1 minute scanner discovers it. Admin `index_library` / `startScan` is **optional ops-only**, not required for the primary workflow.
- Implementation leftover: the worker may still enqueue `index_library` after `import_library`. That is **not** the A3 happy path and must not be documented as required.
- Two radio events only, context from SmartRadio, personality/voice from SUB/WAVE: `REQUEST_ACCEPTED` (acquisition started) and `TRACK_READY` (in library). Notify HTTP = **NEEDS_SERVER_INSPECTION** / **SERVER INSPECTION REQUIRED**.
- Playback handoff remains verified admin `GET /dj/search` + `POST /dj/queue-track` under opaque `base_url` (live example `http://127.0.0.1:7700/api`).
- AcquisitionProvider optional/disabled until a verified daemon exists. Landing dir config example: `/music/downloads`.

Live environment **examples** (never required source defaults): Oracle aarch64 Linux; SUB/WAVE 1.16.0 at `http://127.0.0.1:7700` `/api`; `GET /api/health` → `{"status":"on-air"}`; Ollama `http://100.119.17.28:11434` v0.34.0; paths `/music/downloads` and `/music/library`; no acquisition daemon on Oracle.

## Backend deltas for Bot2 review (additive)

- `REJECTED` remains cancel-terminal but may go to `RECEIVED` (reclassify) or `APPROVED` (operator override; skips reclassification)
- `CLASSIFYING → RECEIVED`, `APPROVED → REJECTED`
- Job type `refresh_playlist`
- `index_library` without `request_id` = **ops-only** standalone Navidrome `startScan` / `getScanStatus` (not the A3 happy path)
- New `/api/v1` routes: setup, ops/disk, ops/logs, ops/overview, request jobs/acquisitions/admin actions, library scan (ops-only), health-probe enqueue
- Download worker stores a best-effort progress snapshot from `GET /api/v0/transfers/downloads` when acquisition is enabled
- `GET /api/v1/doctor` reports `acquire_unavailable`

## NEEDS_SERVER_INSPECTION

| Item | Why |
| --- | --- |
| **SUB/WAVE `REQUEST_ACCEPTED` / `TRACK_READY` notify** | **SERVER INSPECTION REQUIRED.** Semantic events are defined; HTTP path, method, auth, and payload are **not** documented on a live server. Do **not** invent an endpoint. |
| slskd transfer JSON field names | `GET /api/v0/transfers/downloads` is verified when slskd exists; per-file progress keys are inferred only when present (`percentComplete`, `bytesTransferred`, …). Completion vs in-progress is **not** fully specified; the Bot2 worker still advances `DOWNLOADING → DOWNLOAD_COMPLETE` after one poll. |
| slskd search result → enqueue payload | `POST /searches` is verified; mapping a hit to `POST /transfers/downloads/{user}` file body is not copied from a live server. |
| SUB/WAVE webhook payload | Documented as existing; schema not implemented (unchanged). |
| SUB/WAVE `GET /api/connect/openapi.json` | Admin-gated on the radio; not imported. |
| Live OpenAPI of a running SUB/WAVE | Not fetched. Automation still uses verified `/dj/search` + `/dj/queue-track` + `/dj/refresh-playlist`. Notify remains unbound. |
| Navidrome scan status JSON | `startScan` / `getScanStatus` are verified **ops-only** APIs; UI shows worker job result, not a typed scan document. Happy path does not wait on this. |
| Production bind addresses / live hosts | Must be supplied by the operator. Example yaml still uses loopback / relative paths for **local** development only. Oracle examples (`100.119.17.28`, `:7700/api`, `/music/…`) are documentation, not defaults. |

## Out of scope (intentionally)

- Installing or managing Ollama / Qwen / `qwen3:8b`
- Oracle Cloud (or any cloud) deploy steps as executed actions
- Invented AzuraCast, SUB/WAVE notify, or non-slskd Soulseek APIs
- Requiring SmartRadio to trigger Navidrome scans on the happy path
- A second DJ personality / prompt system inside SmartRadio
- Replacing the SmartRadio git remote / creating a new repository
