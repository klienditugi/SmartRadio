# Phase 4 backend notes (Bot2 review)

Phase 4 prefers consuming `/api/v1` as shipped. These additions exist because the UI/ops cannot function without them. They are intended to be small and reviewable.

Amendment **A3** is documentation-first. It does not add a SUB/WAVE notify client and does not make Navidrome `startScan` part of the happy path.

1. **Admin request transitions** — `packages/core` GRAPH: `REJECTED → RECEIVED|APPROVED`, `CLASSIFYING → RECEIVED`, `APPROVED → REJECTED`. `REJECTED → APPROVED` is an explicit operator override that skips reclassification (UI copy says so). Tests updated. `TERMINAL_STATUSES` still includes `REJECTED` (cannot cancel).
2. **Setup write-back** — `POST /api/v1/setup` writes yaml + `secrets/` (known filenames only) and reloads in-process config. Open only when `users` is empty; otherwise admin.
3. **Disk + logs + overview** — `statfs` on configured host paths; SQLite events/jobs/llm_calls.
4. **Acquisition list + progress snapshot** — no new slskd endpoints. Provider remains optional; doctor reports `acquire_unavailable` until a verified daemon exists (none on Oracle today).
5. **`refresh_playlist` job** — maps to verified `POST /dj/refresh-playlist`.
6. **Standalone `index_library`** — **ops-only** Navidrome `startScan` without a request id. A3 happy path does **not** require SmartRadio to trigger scans; Navidrome’s ~1 minute scanner discovers files in `/music/library`. The worker may still enqueue `index_library` after import (leftover, not required).
7. **Static UI** — `@fastify/static` for `apps/web/dist` when present.
8. **Radio events** — semantic `REQUEST_ACCEPTED` and `TRACK_READY` only. Notify HTTP = **NEEDS_SERVER_INSPECTION**. Playback stays on `/dj/search` + `/dj/queue-track`. No DJ personality in SmartRadio.

No live production URLs or credentials were added to source. Oracle examples (`127.0.0.1:7700/api`, Tailscale Ollama, `/music/downloads`, `/music/library`) live in docs only.
