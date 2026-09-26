# Release candidate — Phase 4 (web UI + ops) + Amendments A3, A4, and A5

This branch adds the operator UI, production installer, and Compose/systemd packaging on top of the Bot2 backend foundation. Amendment **A3** locks live-environment examples, a passive Navidrome happy path, two semantic radio events, and optional acquisition. Amendment **A4** binds those events to verified `POST /dj/say` and removes `index_library` from the import happy path. Amendment **A5** makes optional slskd acquisition work end-to-end when verified, while SmartRadio still runs with `acquire_unavailable` when acquisition is unset/unverified. This repository does not deploy to Oracle.

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
- A4 removes the post-import `index_library` enqueue. `import_library` schedules `queue_radio` instead. `IMPORTING → READY` is the happy-path transition. `INDEXING` remains for an explicitly enqueued scan.
- Two radio events only, context from SmartRadio, personality/voice from SUB/WAVE. A4 notify is `POST {base_url}/dj/say` (admin Basic, `mode: "styled"`, `kind` `dj-speak` or `link`, `text` max 500). Success body `{ ok, mode, kind, spoken, sfx }`. Public `POST /request` is not an announcement API.
- `REQUEST_ACCEPTED` runs only after verified `enqueueDownload` succeeds. Search, approval, and a download poll with no transfer do not call `say`. Unverified acquisition fails as `acquire_unavailable` and does not announce.
- `TRACK_READY` order: `GET /dj/search` shows a string `id` → `say` → `POST /dj/queue-track` `{ id, title }` (optional `artist` / `album`). HTTP 409 is never-play. Until search is visible, the worker waits and does not scan Navidrome.
- Playback handoff remains verified admin `GET /dj/search` + `POST /dj/queue-track` under opaque `base_url` (live example `http://127.0.0.1:7700/api`). Library hits use that handoff and do not send `TRACK_READY`.
- AcquisitionProvider optional/disabled until a verified daemon exists. Landing dir config example: `/music/downloads`.
- **A5:** When `acquisition.verify_status` is `verified` and slskd is reachable, the worker runs search → poll → select → enqueue → transfer poll (Completed+Succeeded) → real file under `paths.downloads`. Unverified/missing config still yields `acquire_unavailable`. No false-complete after a single empty poll.
- `llm`, `library`, and `radio` `verify_status` default to `unverified`. Omitted fields and the example yaml are not verified. `verified` is an explicit value, not a schema default. Acquisition `verified` is still written only by test-connection.

Live environment **examples** (never required source defaults): Oracle aarch64 Linux; SUB/WAVE 1.16.0 at `http://127.0.0.1:7700` `/api`; `GET /api/health` → `{"status":"on-air"}`; Ollama `http://100.119.17.28:11434` v0.34.0; paths `/music/downloads` and `/music/library`; acquisition daemon still optional on Oracle.

## Backend deltas for Bot2 review (additive)

- `REJECTED` remains cancel-terminal but may go to `RECEIVED` (reclassify) or `APPROVED` (operator override; skips reclassification)
- `CLASSIFYING → RECEIVED`, `APPROVED → REJECTED`
- Job type `refresh_playlist`
- `index_library` without `request_id` = **ops-only** standalone Navidrome `startScan` / `getScanStatus` (not the happy path; A4 does not enqueue it after import)
- New `/api/v1` routes: setup, ops/disk, ops/logs, ops/overview, request jobs/acquisitions/admin actions, library scan (ops-only), health-probe enqueue
- Download worker stores a best-effort progress snapshot from `GET /api/v0/transfers/downloads` when acquisition is enabled
- `GET /api/v1/doctor` reports `acquire_unavailable`

## NEEDS_SERVER_INSPECTION

| Item | Why |
| --- | --- |
| **SUB/WAVE `REQUEST_ACCEPTED` / `TRACK_READY` notify** | **Bound in A4** to admin `POST /dj/say` (`mode: "styled"`). No further notify URL is invented. Webhook payload schema is still not implemented. |
| slskd transfer JSON field names | `GET /api/v0/transfers/downloads` is verified. Correlation prefers a transfer id from the enqueue body, otherwise exact username + full filename + size (basename only when unique for that user and the size matches). State tokens **Completed + Succeeded** (not Errored) mean done. Per-file progress keys are still best-effort when present. |
| slskd search result → enqueue payload | Poll search responses, then rank in the isolated selector (`acquisition.selection`: size cap, optional duration, broadcast `max_sample_rate` 48000 Hz and `max_bit_depth` 24, version penalty, extension, peer, quality within those caps, typical size) → `{username,filename,size}` for `POST /transfers/downloads/{user}`. Files that omit sample rate or bit depth stay eligible. If the filters remove every candidate, the request fails as `no_suitable_result` with per-filter counts and nothing is enqueued. Zero responses stay `no usable search result`. The filename is the original string. Search responses have no id. |
| SUB/WAVE webhook payload | Documented as existing; schema not implemented (unchanged). |
| SUB/WAVE `GET /api/connect/openapi.json` | Admin-gated on the radio; not imported. |
| Live OpenAPI of a running SUB/WAVE | Not fetched. Automation uses verified `/dj/search`, `/dj/queue-track`, `/dj/say`, and `/dj/refresh-playlist`. |
| Navidrome scan status JSON | `startScan` / `getScanStatus` are verified **ops-only** APIs; UI shows worker job result, not a typed scan document. Happy path does not wait on this. |
| Production bind addresses / live hosts | Must be supplied by the operator. Example yaml still uses loopback / relative paths for **local** development only. Oracle examples (`100.119.17.28`, `:7700/api`, `/music/…`) are documentation, not defaults. |

## Out of scope (intentionally)

- Installing or managing Ollama / Qwen / `qwen3:8b`
- Oracle Cloud (or any cloud) deploy steps as executed actions
- Invented AzuraCast APIs, a second notify URL besides `POST /dj/say`, or non-slskd Soulseek APIs
- Requiring SmartRadio to trigger Navidrome scans on the happy path
- A second DJ personality / prompt system inside SmartRadio
- Replacing the SmartRadio git remote / creating a new repository
