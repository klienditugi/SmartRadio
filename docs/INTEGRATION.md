# INTEGRATION.md — Sub Wave AI Radio Automation (Bot3 VERIFIED + Amendments A3 and A4)
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
- Admin Basic: `GET /dj/search`, `POST /dj/queue-track`, `POST /dj/say`, `POST /dj/refresh-playlist`
- Auth classes: public | station password | admin Basic
- Playback handoff MUST use admin `/dj/search` + `/dj/queue-track` under the opaque `/api` `base_url`
- `POST /dj/queue-track` body: `id` and `title` required; `artist` and `album` optional. HTTP 409 = never-play
- Do NOT invent AzuraCast APIs
- Do NOT use public `POST /request` for announcements
- Webhooks exist; payload schema NEEDS live OpenAPI

### Semantic radio events (A4) — `POST /dj/say`

SmartRadio supplies **context text only**. SUB/WAVE owns DJ personality, wording, voice, station identity, and spoken announcement (`mode` is always `"styled"`). Do **not** add a second DJ prompt system here.

`POST {base_url}/dj/say` uses the same admin Basic auth as the other admin DJ routes.

| Field | Rule |
| --- | --- |
| `text` | Required. Max 500 characters (adapter truncates). Empty text is rejected. |
| `mode` | Always `"styled"`. |
| `kind` | `"dj-speak"` (default) or `"link"`. |
| `sfx` | Optional passthrough. |

Success body: `{ ok, mode, kind, spoken, sfx }`.

| Semantic event | When SmartRadio calls `say` |
| --- | --- |
| `REQUEST_ACCEPTED` | Verified `AcquisitionProvider.enqueueDownload` has returned. Factual context only (event name, optional requester username, track label, “Acquisition has started.”). Not announcer dialogue. Not sent if acquisition is unavailable or no transfer was enqueued. |
| `TRACK_READY` | Download validated, file placed in the music library, and `GET /dj/search?q=` returned a string `id`. Factual context only (event name, optional requester, track label, validated/available for airplay). Order: visible → `say` → `POST /dj/queue-track`. |

## Soulseek / acquisition (VERIFIED via slskd only) — AcquisitionProvider (optional)

- HTTP `/api/v0`, default port `:5030` **when a slskd exists**
- Auth: `X-API-Key` or session JWT
- Health (when verifying): `GET /application` + `GET /server`
- Admin test connection (`POST /api/v1/acquisition/test-connection`) calls only those two GETs with `X-API-Key`. `verify_status: verified` is stored only when the server body has `isConnected: true` and `isLoggedIn: true`. The call does not search or download. See `docs/SLSKD.md` for running slskd outside this app.
- Search: `POST /searches` `{ id, searchText }`, then poll `GET /searches/{id}?includeResponses=true` (fallback `GET /searches/{id}/responses`) until complete
- Select a usable file `{ username, filename, size }` in an isolated selection module
- Download: `POST /transfers/downloads/{username}` body `[{filename,size}]`
- Poll `GET /transfers/downloads` until the **correlated** transfer is **Completed** and **Succeeded** (not Errored); then resolve the real file under configured `paths.downloads`
- If not slskd, leave unverified — do not invent other APIs
- **Optional:** SmartRadio runs with acquisition unset/unverified → doctor/`acquire_unavailable`. No Oracle/ARM64 requirements in app code. Landing dir is config-only (live example `/music/downloads`).
