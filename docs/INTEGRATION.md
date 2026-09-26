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

`llm.verify_status` defaults to `unverified` when omitted. A blank or fresh config is not verified, and the adapter does not call Ollama until that field is `verified`. Filling in the URL does not set it. If the URL and model are filled and `verify_status` was never written, doctor, the status API, and the dashboard report `configured_unverified` with “configured but unverified, run test connection”. That is not a promotion to verified.

`POST /api/v1/llm/test-connection` is the only writer of `llm.verify_status: verified`. It is a read-only `GET /api/tags` and checks that the configured model is in the list. It does not pull, install, or restart Ollama. Failure persists `unverified` and returns `not_configured`, `unreachable`, `auth_failed`, or `model_missing`. `GET /api/v1/llm/status` does not write `verified`. Saving settings cannot set `verified`.

- HTTP `base_url` configurable (local-dev placeholder often `http://127.0.0.1:11434`; live example above). Not a required default.
- Classification: `POST /api/chat` with `stream: false` + `format` JSON schema
- Health: `GET /api/tags` or `GET /api/version`
- Also has OpenAI-compatible `/v1/chat/completions` for future providers
- Model name configurable; do NOT hard-code Qwen / `qwen3:8b`
- Never pull/manage models from this app
- Classification is station policy input only — not a DJ personality

## Navidrome (VERIFIED docs) — MusicLibraryProvider — **passive**

`library.verify_status` defaults to `unverified` when omitted. A blank or fresh config is not verified, and the adapter does not call Navidrome until that field is `verified`. Filling in the URL does not set it. Filled URL, username, and password with no explicit `verify_status` report `configured_unverified` (“configured but unverified, run test connection”).

`POST /api/v1/library/test-connection` is the only writer of `library.verify_status: verified`. It calls Subsonic `GET /rest/ping` with the existing token auth and `f=json`. Ready requires `status: ok`. Failure persists `unverified` (`not_configured`, `unreachable`, or `auth_failed`). The password is not logged or returned. `GET /api/v1/library/status` does not write `verified`.

- Subsonic API 1.16.1 at `{url}/rest`, prefer `f=json`
- Auth: `u` + `t/s` (md5 token from password + salt)
- Happy-path methods: `search3`, `getSong`
- Ops-only methods: `startScan`, `getScanStatus` (admin index / scan-trigger). **Not required** for the primary workflow.
- IDs are strings end-to-end
- A3: SmartRadio does **not** manage Navidrome scanning on the happy path. After a validated file is in `/music/library`, the existing ~1 minute scanner discovers it.

## SUB/WAVE (VERIFIED = perminder-klair/subwave) — RadioProvider

`radio.verify_status` defaults to `unverified` when omitted. A blank or fresh config is not verified, and the adapter does not call SUB/WAVE until that field is `verified`. Filling in the URL does not set it. Filled URL, admin user, and password with no explicit `verify_status` report `configured_unverified` (“configured but unverified, run test connection”).

`POST /api/v1/radio/test-connection` is the only writer of `radio.verify_status: verified`. It calls public `GET /health` (must report `{"status":"on-air"}`) and one authenticated read-only admin call, `GET /dj/search?q=a&limit=1`. It does not call `/dj/say` or `/dj/queue-track`. Failure persists `unverified` (`not_configured`, `unreachable`, `auth_failed`, or `unhealthy`). Credentials are not logged or returned. `GET /api/v1/radio/status` does not write `verified`.

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
- Health (when verifying): `GET /application` + `GET /server`. Ready requires application `version` plus Soulseek `isConnected` and `isLoggedIn` (or `state` flags). `isConnected` alone is not logged in. Optional external slskd: `docs/SLSKD.md`.
- Search: `POST /searches` `{ id, searchText }`, then poll `GET /searches/{id}?includeResponses=true` (fallback `GET /searches/{id}/responses`) until complete
- Select a usable file `{ username, filename, size }` in an isolated selection module. Config: `acquisition.selection.max_file_size_mb` (default 200 mebibytes), optional `max_duration_seconds` (no limit unless set; uses slskd `length`), `max_sample_rate` (default 48000 Hz) and `max_bit_depth` (default 24, both broadcast-friendly and configurable), and `version_penalty_terms`. A reported sample rate or bit depth above its cap is excluded; a file that omits the field stays eligible and ranks neutral on that key. Rank: extension (`.flac`, `.wav`, `.m4a`, `.mp3`, `.ogg`), then a clean version over a penalized one, then peer availability (free upload slot, then shorter queue, then faster upload; missing fields last), then bit depth / sample rate / bit rate at or under the caps (a higher rate beyond the cap is not rewarded), then size closest to the same-extension median, then username and filename. `lockedFiles` and `isLocked: true` are never chosen. An empty `extension` falls back to the filename. If the filters remove every candidate, the selector returns no pick and does not relax them; the worker fails the request as `no_suitable_result` (counts per filter) without enqueueing. Zero responses are `no usable search result`, not that outcome. Search responses have no id.
- Download: `POST /transfers/downloads/{username}` body `[{filename,size}]` with the original filename string (Windows backslashes are not rewritten)
- Poll `GET /transfers/downloads` until the **correlated** transfer is **Completed** and **Succeeded** (not Errored). Correlation prefers a transfer id observed from the enqueue response; otherwise exact username + full filename + size. A basename match is used only when exactly one of that user's rows matches the basename and the size. Then resolve the real file under configured `paths.downloads`
- If not slskd, leave unverified — do not invent other APIs
- **Optional:** SmartRadio runs with acquisition disabled, unset, or unverified → doctor/`acquire_unavailable`. No Oracle/ARM64 requirements in app code. Landing dir is config-only (live example `/music/downloads`).
- Soulseek username and password are **not** SmartRadio settings. slskd keeps them. SmartRadio stores only `secrets/slskd_api_key`.

## A6 acquisition settings (no download enqueue)

Admin session required. Responses never include the API key — only `secrets_present.slskd_api_key: boolean`.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/v1/acquisition/settings` | `enabled`, `provider` (`slskd`, other names allowed), `base_url`, `paths.downloads`, `paths.library`, `verify_status`, `secrets_present.slskd_api_key` |
| `PUT` | `/api/v1/acquisition/settings` | Same fields plus write-only `slskd_api_key`. Does **not** set `verified`. Changing provider, base URL, or API key sets `unverified`. |
| `POST` | `/api/v1/acquisition/test-connection` | Read-only `GET /api/v0/application` and `GET /api/v0/server` with `X-API-Key`. No search or download. Sets `verified` only when the host is reachable, auth succeeds, application JSON includes `version`, and Soulseek is connected and logged in (`isConnected` and `isLoggedIn`, or server `state` flags). Otherwise persists `unverified`. |
| `GET` | `/api/v1/acquisition/status` | `disabled`, `not_configured`, `unreachable`, `auth_failed`, `reachable`, `soulseek_not_connected`, `soulseek_not_logged_in`, or `ready`. Disabled and not-configured come from config and do not call slskd. Every other state is the live probe, not a copy of saved `verify_status`. |

`POST /api/v1/setup` accepts `config.acquisition.enabled`, `provider`, `base_url`, and `paths.downloads` / `paths.library`, and `secrets.slskd_api_key`. It can persist `verify_status` of `unverified` or `needs_server_inspection`. It cannot set `verified`.
