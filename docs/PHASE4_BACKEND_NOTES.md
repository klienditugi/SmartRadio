# Phase 4 backend notes (Bot2 review)

Phase 4 prefers consuming `/api/v1` as shipped. These additions exist because the UI/ops cannot function without them. They are intended to be small and reviewable.

1. **Admin request transitions** — `packages/core` GRAPH: `REJECTED → RECEIVED|APPROVED`, `CLASSIFYING → RECEIVED`, `APPROVED → REJECTED`. `REJECTED → APPROVED` is an explicit operator override that skips reclassification (UI copy says so). Tests updated. `TERMINAL_STATUSES` still includes `REJECTED` (cannot cancel).
2. **Setup write-back** — `POST /api/v1/setup` writes yaml + `secrets/` (known filenames only) and reloads in-process config. Open only when `users` is empty; otherwise admin.
3. **Disk + logs + overview** — `statfs` on configured host paths; SQLite events/jobs/llm_calls.
4. **Acquisition list + progress snapshot** — no new slskd endpoints.
5. **`refresh_playlist` job** — maps to verified `POST /dj/refresh-playlist`.
6. **Standalone `index_library`** — Navidrome scan without a request id.
7. **Static UI** — `@fastify/static` for `apps/web/dist` when present.

No live production URLs or credentials were added to source.
