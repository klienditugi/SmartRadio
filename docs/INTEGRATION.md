# INTEGRATION.md — Sub Wave AI Radio Automation (Bot3 VERIFIED + Amendment A3)
#
# Local clone directory is always `subwave-ai` (GitHub remote/repo may be SmartRadio):
#   git clone <repo-url> subwave-ai && cd subwave-ai && sudo ./install.sh
#
# Live URLs below are **config examples**. Never hard-code them as required app defaults.

Live URLs/credentials are configurable and NEEDS_SERVER_INSPECTION unless noted.

## Live environment examples (A3 — operator config only)

- Oracle VM: aarch64 Linux
- SUB/WAVE 1.16.0: `http://127.0.0.1:7700` with real API base path `/api` → opaque `base_url` `http://127.0.0.1:7700/api`
  - Verified: `GET /api/health` → `{"status":"on-air"}`
  - Verified: `GET /api/state`
  - Verified: `GET /api/now-playing`
- Ollama remote over Tailscale: `http://100.119.17.28:11434` v0.34.0
  - `qwen3:8b` may exist; **must not** be hard-coded
- Paths: `/music/downloads` = acquisition landing/staging; `/music/library` = final library
- No acquisition daemon currently on Oracle

## Ollama (VERIFIED docs) — external only, never install/manage

- HTTP `base_url` configurable (local-dev placeholder often `http://127.0.0.1:11434`; live example above). Not a required default.
- Classification: `POST /api/chat` with `stream: false` + `format` JSON schema
- Health: `GET /api/tags` or `GET /api/version`
- Also has OpenAI-compatible `/v1/chat/completions` for future providers
- Model name configurable; do NOT hard-code Qwen / `qwen3:8b`
- Never pull/manage models from this app
- Classification is station policy input only — not a DJ personality

## Navidrome (VERIFIED docs) — MusicLibraryProvider — **passive**

- Subsonic API 1.16.1 at `{url}/rest`, prefer `f=json`
- Auth: `u` + `t/s` (md5 token from password + salt)
- Happy-path methods: `search3`, `getSong`
- Ops-only methods: `startScan`, `getScanStatus` (admin index / scan-trigger). **Not required** for the primary workflow.
- IDs are strings end-to-end
- A3: SmartRadio does **not** manage Navidrome scanning on the happy path. After a validated file is in `/music/library`, the existing ~1 minute scanner discovers it.

## SUB/WAVE (VERIFIED = perminder-klair/subwave) — RadioProvider

- HTTP JSON; treat `base_url` as opaque (live example already includes `/api`: `http://127.0.0.1:7700/api`)
- Public (relative to that opaque base): `GET /health` → `{"status":"on-air"}`, `GET /now-playing`, `GET /state`; `POST /request` (202+requestId); `GET /request/:id`
- Admin Basic: `GET /dj/search`, `POST /dj/queue-track`, `POST /dj/refresh-playlist`
- Auth classes: public | station password | admin Basic
- Playback handoff MUST use admin `/dj/search` + `/dj/queue-track` under the opaque `/api` `base_url`
- Do NOT invent AzuraCast APIs
- Webhooks exist; payload schema NEEDS live OpenAPI

### Semantic radio events (A3) — notify = SERVER INSPECTION REQUIRED

SmartRadio supplies **event + context only**. SUB/WAVE owns DJ personality, wording, voice, station identity, and spoken announcement. Do **not** add a second DJ prompt system here.

| Semantic event | Meaning | HTTP binding |
| --- | --- | --- |
| `REQUEST_ACCEPTED` | Acquisition started (“song is coming”) | **NEEDS_SERVER_INSPECTION** / **SERVER INSPECTION REQUIRED** — do not invent an endpoint |
| `TRACK_READY` | Validated + in `/music/library` (“ready / on soon”) | **NEEDS_SERVER_INSPECTION** / **SERVER INSPECTION REQUIRED** — do not invent an endpoint |

Until a live SUB/WAVE documents notify path, method, auth, and payload, SmartRadio records the semantic event locally (request/job context) and continues playback via verified `/dj/search` + `/dj/queue-track` only.

## Soulseek / acquisition (VERIFIED via slskd only) — AcquisitionProvider (optional)

- HTTP `/api/v0`, default port `:5030` **when a slskd exists**
- Auth: `X-API-Key` or session JWT
- Search: `POST /searches`
- Download: `POST /transfers/downloads/{user}`
- Poll transfers for progress
- If not slskd, leave unverified — do not invent other APIs
- A3: **no acquisition daemon on Oracle**. Keep the provider optional/disabled (`verify_status: unverified`) until a verified service exists. Doctor must surface `acquire_unavailable`. Landing dir config → `/music/downloads`.
