# INTEGRATION.md — Sub Wave AI Radio Automation (Bot3 VERIFIED)

Live URLs/credentials are configurable and NEEDS_SERVER_INSPECTION unless noted.

## Ollama (VERIFIED docs) — external only, never install/manage
- HTTP `base_url` configurable (default `http://127.0.0.1:11434`)
- Classification: `POST /api/chat` with `stream: false` + `format` JSON schema
- Health: `GET /api/tags` or `GET /api/version`
- Also has OpenAI-compatible `/v1/chat/completions` for future providers
- Model name configurable; do NOT hard-code Qwen
- Never pull/manage models from this app

## Navidrome (VERIFIED docs) — MusicLibraryProvider
- Subsonic API 1.16.1 at `{url}/rest`, prefer `f=json`
- Auth: `u` + `t/s` (md5 token from password + salt)
- Methods: `search3`, `getSong`, `startScan`, `getScanStatus`
- IDs are strings end-to-end

## SUB/WAVE (VERIFIED = perminder-klair/subwave) — RadioProvider
- HTTP JSON; treat `base_url` as opaque (prod may be `:7700/api` with strip)
- Public: `GET /health`, `/now-playing`, `/state`; `POST /request` (202+requestId); `GET /request/:id`
- Admin Basic: `GET /dj/search`, `POST /dj/queue-track`, `POST /dj/refresh-playlist`
- Auth classes: public | station password | admin Basic
- Automation MUST prefer admin `/dj/search` + `/dj/queue-track` over public request
- Do NOT invent AzuraCast APIs
- Webhooks exist; payload schema NEEDS live OpenAPI

## Soulseek / acquisition (VERIFIED via slskd only) — AcquisitionProvider
- HTTP `/api/v0`, default port `:5030`
- Auth: `X-API-Key` or session JWT
- Search: `POST /searches`
- Download: `POST /transfers/downloads/{user}`
- Poll transfers for progress
- If not slskd, leave unverified — do not invent other APIs
