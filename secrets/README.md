# Secrets directory

Place one secret per file in the local clone directory named `subwave-ai`. Do not commit real values.

| File | Used by |
| --- | --- |
| `admin_password` | Bootstrap admin user for the API (required to sign in) |
| `session_secret` | Session cookie signing / token hashing salt (required to sign in) |
| `navidrome_password` | Navidrome Subsonic `t/s` auth (optional). Missing or blank leaves Navidrome `not_configured`. |
| `subwave_admin_password` | SUB/WAVE admin HTTP Basic (optional). Missing or blank leaves SUB/WAVE `not_configured`. |
| `slskd_api_key` | slskd `X-API-Key` (optional). The setup UI writes this file and never returns the value. Soulseek username/password are not SmartRadio secrets. |

Override the directory with `SUBWAVE_SECRETS_DIR`. Values are never written back by the LLM or workers.
