# INTEGRATION.md — Sub Wave AI Radio Automation (Bot3 VERIFIED + Amendments A3 and A4)
#
# Local clone directory is always `subwave-ai` (GitHub remote/repo may be SmartRadio):
#   git clone <repo-url> subwave-ai && cd subwave-ai && sudo ./install.sh
#
# Live URLs below are **config examples**. Never hard-code them as required app defaults.

Live URLs/credentials are configurable and NEEDS_SERVER_INSPECTION unless noted.

Navidrome, SUB/WAVE, and Ollama settings are **optional at first boot**. Empty or unset URL, user, and password/secret values are the same thing. The API still starts. Status is `not_configured` until they are set (distinct from `unreachable`, which is only used after a configured health probe cannot connect). Calls that need the integration fail with a not-configured error. Ollama is never installed, and no model name is defaulted.

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

`POST /api/v1/llm/test-connection` is the only writer of a verified LLM result. It stores the probe in `integration_checks` (state, tested_at, and an HMAC-SHA256 fingerprint that is not returned). It is a read-only `GET /api/tags` and checks that the configured model is in the list. It does not pull, install, or restart Ollama. Failure stores the probe state (`unreachable`, `auth_failed`, or `model_missing`) and leaves `verify_status` unverified. Yaml `verify_status` is ignored. `GET /api/v1/llm/status` reads the stored result and does not call Ollama. Saving settings cannot set `verified`.

- HTTP `base_url` configurable (local-dev placeholder often `http://127.0.0.1:11434`; live example above). Not a required default.
- Classification: `POST /api/chat` with `stream: false` + `format` JSON schema
- Health: `GET /api/tags` or `GET /api/version`
- Also has OpenAI-compatible `/v1/chat/completions` for future providers
- Model name configurable; do NOT hard-code Qwen / `qwen3:8b`
- Never pull/manage models from this app
- Classification is station policy input only — not a DJ personality

## Navidrome (VERIFIED docs) — MusicLibraryProvider — **passive**

`library.verify_status` defaults to `unverified` when omitted. A blank or fresh config is not verified, and the adapter does not call Navidrome until that field is `verified`. Filling in the URL does not set it. Filled URL, username, and password with no explicit `verify_status` report `configured_unverified` (“configured but unverified, run test connection”).

`POST /api/v1/library/test-connection` is the only writer of a verified library result. It stores the probe in `integration_checks`. It calls Subsonic `GET /rest/ping` with the existing token auth and `f=json`. Ready requires `status: ok`. Failure stores `unreachable` or `auth_failed`. The password is not logged, returned, or stored. The fingerprint is one HMAC-SHA256 of the settings and the password, keyed by `secrets/verification_hmac_key`. The fingerprint itself is not logged or returned. `GET /api/v1/library/status` reads the stored result and does not call Navidrome.

- Subsonic API 1.16.1 at `{url}/rest`, prefer `f=json`
- Auth: `u` + `t/s` (md5 token from password + salt)
- Happy-path methods: `search3`, `getSong`
- Ops-only methods: `startScan`, `getScanStatus` (admin index / scan-trigger). **Not required** for the primary workflow.
- IDs are strings end-to-end. A numeric JSON id is coerced to a string at the parse boundary before it is stored or compared. `getMusicFolders` returns folder id `1` as a number; that value is `"1"`. `search3` and `getSong` use the same coercion. `getMusicFolders` is not on the request path.
- A3: SmartRadio does **not** manage Navidrome scanning on the happy path. After a validated file is in `/music/library`, the existing ~1 minute scanner discovers it.

## SUB/WAVE (VERIFIED = perminder-klair/subwave) — RadioProvider

`radio.verify_status` defaults to `unverified` when omitted. A blank or fresh config is not verified, and the adapter does not call SUB/WAVE until that field is `verified`. Filling in the URL does not set it. Filled URL, admin user, and password with no explicit `verify_status` report `configured_unverified` (“configured but unverified, run test connection”).

`POST /api/v1/radio/test-connection` is the only writer of a verified radio result. It stores the probe in `integration_checks`. It calls public `GET /health` (must report `{"status":"on-air"}`) and one authenticated read-only admin call, `GET /dj/search?q=a&limit=1`. It does not call `/dj/say` or `/dj/queue-track`. Failure stores `unreachable`, `auth_failed`, or `unhealthy`. Credentials are not logged or returned. `GET /api/v1/radio/status` reads the stored result and does not call SUB/WAVE.

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

`POST /dj/say` is admin only. There is no `context` field. `mode: "styled"` uses `text` as the operator instruction and cuts it at 300 characters. Any other `mode` is raw. If the SUB/WAVE LLM fails, the route returns HTTP 500 and nothing goes on air.

| Field | Rule |
| --- | --- |
| `text` | Required, trimmed. Wire max 500 characters (adapter truncates). Listener facts are capped at 300. A long artist or title is shortened first so the `event` and `reason` lines stay whole. Empty text is rejected. |
| `mode` | Listener says send `"styled"`. |
| `kind` | Listener says send `"dj-speak"` (the adapter default when `kind` is omitted). `"link"` is the other accepted value. |
| `sfx` | Not sent on listener says. |

Success body: `{ ok, mode, kind, spoken, sfx }`. HTTP 500, and any other say error, is logged and swallowed. It does not change request state and it is not retried.

`text` is short newline-separated facts. SmartRadio does not send announcer sentences. Lines, and only the ones that apply:

- `event: <name>`
- `track: <artist - title>` (the raw query when artist and title are unset)
- `requester: <display name already stored for the requester>`
- `reason: <stable category>`

No peer username, filename, path, or internal id. Each event is claimed once per request in `listener_say_events` before the POST. A failed send is logged and is not retried. A say failure does not change request state.

| `event` | When SmartRadio calls `say` | Lines |
| --- | --- | --- |
| `request_received` | `check_library`, after classify has approved the request and before the library search. Library hits are included. `POST /requests` is too early. `search_acquisition` does not run for a library hit. | `event`, `track` when known, `requester` when known |
| `copy_found_retrieval_started` | Download processor, after verified `enqueueDownload`, the move to `DOWNLOADING` (`REQUEST_ACCEPTED`), and poll scheduling. Not sent when acquisition is unavailable or no transfer was enqueued. | `event`, `track` when known, `requester` when known |
| `queued_coming_up` | After `POST /dj/queue-track` succeeds and the request is `READY`. | `event`, `track` when known, `requester` when known |
| `request_failed` | The single `FAILED` transition. `reason` is a stable category (`no_suitable_result`, `enqueue_failed`, `never_play`, `radio_unreachable`, a terminal transfer state, and the other existing codes), never a raw error string. Station-policy rejection stays `REJECTED` and is not moved to `FAILED`; that path still sends this say once with `reason: out_of_format`. | `event`, `track` when known, `requester` when known, `reason` |

`TRACK_READY` stays the `READY` payload event for a post-import queue. It is not a say. Download validated, file moved into the music library, and `GET /dj/search?q=` returned exactly one id (a JSON number is coerced to a string at parse) whose normalized artist and title match and whose version class equals the selected file. A bare title or Original Mix is `original`; other accepted labels use the selector classes. Zero or several hits in that class fail immediately as `handoff_ambiguous` (not queued, library file kept, no new acquisition). The defined body has `id` and `title`, optional `artist` and `album`, and no path, filename, or duration, so this is not a file identity match. A numeric `id` is coerced to a string before it is queued or stored. Order: match → `POST /dj/queue-track` → `queued_coming_up`. The search wait is capped by `radio.search_visible_timeout_ms` (default 30 minutes). At the cap with no id the request fails as `search_visible_timeout`. Visible hits that do not match artist and title fail as `handoff_no_match`. If `/dj/search` cannot connect and that job uses up its attempts, the request fails as `radio_unreachable`. HTTP 409 is `request_failed` with `reason: never_play`. `acquire_unavailable` is still a retryable job error: the request is not moved to `FAILED`, and there is no say until some later path actually fails it.

## Soulseek / acquisition (VERIFIED via slskd only) — AcquisitionProvider (optional)

- HTTP `/api/v0`, default port `:5030` **when a slskd exists**
- Auth: `X-API-Key` or session JWT
- Health (when verifying): `GET /application` + `GET /server`. Ready requires application `version` plus Soulseek `isConnected` and `isLoggedIn` (or `state` flags). `isConnected` alone is not logged in. Optional external slskd: `docs/SLSKD.md`.
- Search: `POST /searches` `{ id, searchText }`, then poll `GET /searches/{id}?includeResponses=true` (fallback `GET /searches/{id}/responses`) until complete
- Select a usable file `{ username, filename, size }` in an isolated selection module. Hard rejects run first: wrong artist or title (the title phrase must start at a boundary in the original basename, including after a closing `)` or `]` or directly after the requested artist name; punctuation is normalized to spaces only for that comparison, and anything after the phrase is allowed), medley (including the whole word `mashup`, `mash up`, `segue`, `transition`, `vs`, or `versus` in the basename, two other titles joined by a capitalised tight hyphen, or `vs` / `versus` in the folder the artist was taken from), tribute or cover (including the whole word `cover` in the basename), stems, locked, under 1 MiB, under 128 kbps, over `max_file_size_mb` (default 30), the duration cap, a long recording, and a short recording. `mp3_only` and `flac_only` stay hard filters. Junk paths (`._` basename or a `__MACOSX` segment) are excluded. A reported sample rate above `max_sample_rate` (default 48000 Hz) or bit depth above `max_bit_depth` (default 24) is excluded; a file that omits the field stays eligible. `preferred_max_file_size_mb` and `preferred_max_duration_seconds` still load so older yaml works, and the selector ignores them. Survivors are then compared in plain order, stopping at the first difference: explicit basename version, version class, quality, format, peer, username and path. If nothing survives, the selector returns no pick and the worker fails the request as `no_suitable_result` without enqueueing. Zero responses are `no usable search result`, not that outcome. See `docs/SLSKD.md`. `lockedFiles` and `isLocked: true` are never chosen. An empty `extension` falls back to the filename. Search responses have no id.
- Download: `POST /transfers/downloads/{username}` body `[{filename,size}]` with the original filename string (Windows backslashes are not rewritten). A chosen file with no positive `length` fails as `selected_missing_length` before that POST. Nothing is enqueued, and the selector is not run again. Before the POST, one download job stores `enqueue_attempted` (username, filename, size, timestamp) with a compare-and-set on `jobs.payload_json`. If that marker is already set, the worker does not POST again. A 4xx from that POST fails the request at once as `enqueue_failed` and records the status. The marker is not cleared. A 5xx checks `GET /transfers/downloads` once for the same username, filename, and size. A matching row is adopted and the request moves to `DOWNLOADING`. No row, or a failed GET, fails as `enqueue_failed` with that 5xx status. The marker stays, and there is no second POST. A timeout, network error, or lost reply does not fail yet: the worker only polls `GET /transfers/downloads` for the same username, filename, and size, adopts that row when it appears, and fails as `transfer_not_found` when nothing appears before `acquisition.download_timeout_ms`. A 201/204 is stored on the acquisition item and the job before the move to `DOWNLOADING`. `say` runs after that and a failure does not change the request. A retry checks that stored state and `GET /transfers/downloads` for the same username, filename, and size, and does not POST again.
- Poll `GET /transfers/downloads` until the **correlated** transfer is **Completed** and **Succeeded**. A transfer id matches only when username, filename, and size match too. Two rows with the same filename and size are not a match. `TimedOut`, `Rejected`, `Failed`, `Errored`, and `Cancelled` fail the request with that state and do not enqueue again. `acquisition.download_timeout_ms` (default 6 hours) fails the request as `download_timeout` and does not cancel or delete anything on slskd. The completed file is `paths.downloads/<last folder of the remote path>/<basename>` (backslash separators count), and only when the byte size equals the transfer. There is no basename search and no glob. slskd 0.26 `Transfer` has no local path (`filename` is the remote path). If one is reported, `acquisition.downloads_path_prefix` (default `/downloads`, the directory as slskd sees it) is stripped and the remainder is joined onto `paths.downloads`. Nothing matching, or more than one exact-size match, fails as `download_not_found` and the error lists every path tried.
- After validation (extension, size, and ffprobe), that one file is **moved** downloads → staging → library. ffprobe (`files.ffprobe_path`, default `ffprobe`) is spawned with an argument list and `shell: false`. It must show a codec and format that match the extension. A selected file with no length fails as `duration_unknown`. When a length is known, the probed duration must be within 2 seconds. A missing ffprobe fails as `ffprobe_unavailable` (the worker host needs `ffmpeg` installed). Same filesystem uses rename. Across filesystems the worker copies to a temporary name in the destination directory, fsyncs when it can, checks that the destination byte size matches the source and the transfer size, renames the temporary file into place, and then deletes the source. A failed check deletes the temporary file and keeps the source. An existing library file is not replaced. Other files in downloads stay. An empty directory that held only this file, under downloads and not the downloads root, may be removed. That is not a recursive delete. The worker needs permission to unlink that file in the shared completed-downloads directory.
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
| `GET` | `/api/v1/acquisition/status` | `disabled`, `not_configured`, `configured_unverified`, or the stored probe state (`unreachable`, `auth_failed`, `reachable`, `soulseek_not_connected`, `soulseek_not_logged_in`, `ready`). It does not call slskd. `POST /acquisition/test-connection` is the live probe and the only writer of a verified row. |

`POST /api/v1/setup` accepts `config.acquisition.enabled`, `provider`, `base_url`, and `paths.downloads` / `paths.library`, and `secrets.slskd_api_key`. It can persist `verify_status` of `unverified` or `needs_server_inspection`. It cannot set `verified`.
