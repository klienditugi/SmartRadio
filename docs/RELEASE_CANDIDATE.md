# Release candidate — Phase 4 (web UI + ops)

This branch adds the operator UI, production installer, and Compose/systemd packaging on top of the Bot2 backend foundation.

## What is in

- Responsive Vite/React console (`apps/web`) consuming `/api/v1`
- First-run / settings wizard (no hard-coded production IPs, credentials, ports, or model names)
- Dashboard, request/job queue with canonical states, download progress snapshot, errors/logs, disk
- Auth + admin actions: retry, cancel, approve, reject, reclassify, retry acquisition, Navidrome scan, radio playlist refresh (enqueue-only)
- Root `install.sh`, `update.sh`, `uninstall.sh`, `backup.sh`, `restore.sh`, `doctor.sh`
- `deploy/docker-compose.yml` + `deploy/Dockerfile` with **host-mounted** data and library
- Tests for API extras, progress extraction, UI helpers, ops script contracts

Clone story remains:

```bash
git clone <repo-url> subwave-ai
cd subwave-ai
sudo ./install.sh
```

Ollama is never installed, updated, or pulled.

## Backend deltas for Bot2 review (additive)

- `REJECTED` remains cancel-terminal but may go to `RECEIVED` (reclassify) or `APPROVED` (admin override)
- `CLASSIFYING → RECEIVED`, `APPROVED → REJECTED`
- Job type `refresh_playlist`
- `index_library` without `request_id` = standalone Navidrome `startScan` / `getScanStatus`
- New `/api/v1` routes: setup, ops/disk, ops/logs, ops/overview, request jobs/acquisitions/admin actions, library scan, health-probe enqueue
- Download worker stores a best-effort progress snapshot from `GET /api/v0/transfers/downloads`

## NEEDS_SERVER_INSPECTION

| Item | Why |
| --- | --- |
| slskd transfer JSON field names | `GET /api/v0/transfers/downloads` is verified; per-file progress keys are inferred only when present (`percentComplete`, `bytesTransferred`, …). Completion vs in-progress is **not** fully specified; the Bot2 worker still advances `DOWNLOADING → DOWNLOAD_COMPLETE` after one poll. |
| slskd search result → enqueue payload | `POST /searches` is verified; mapping a hit to `POST /transfers/downloads/{user}` file body is not copied from a live server. |
| SUB/WAVE webhook payload | Documented as existing; schema not implemented (unchanged). |
| SUB/WAVE `GET /api/connect/openapi.json` | Admin-gated on the radio; not imported. |
| Live OpenAPI of a running SUB/WAVE | Not fetched. Automation still uses verified `/dj/search` + `/dj/queue-track` + `/dj/refresh-playlist`. |
| Navidrome scan status JSON | `startScan` / `getScanStatus` are verified; UI shows worker job result, not a typed scan document. |
| Production bind addresses | Must be supplied by the operator. Example yaml still uses loopback placeholders for **local** development only. |

## Out of scope (intentionally)

- Installing or managing Ollama / Qwen
- Oracle Cloud (or any cloud) deploy steps as executed actions
- Invented AzuraCast or non-slskd Soulseek APIs
- Replacing the SmartRadio git remote / creating a new repository
