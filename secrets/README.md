# Secrets directory

Place one secret per file. Do not commit real values.

| File | Used by |
| --- | --- |
| `admin_password` | Bootstrap admin user for the API |
| `session_secret` | Session cookie signing / token hashing salt |
| `navidrome_password` | Navidrome Subsonic `t/s` auth |
| `subwave_admin_password` | SUB/WAVE admin HTTP Basic |
| `slskd_api_key` | slskd `X-API-Key` |

Override the directory with `SUBWAVE_SECRETS_DIR`. Values are never written back by the LLM or workers.
