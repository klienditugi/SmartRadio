# Deployment — Sub Wave AI (`subwave-ai`)

This document describes how to install the software **in this repository**. It does not execute or prescribe an Oracle Cloud deployment.

Amendment **A3** live values below are **operator config examples**. They are never required application defaults and must not be copied into source as hard-coded hosts, models, or paths.

## Clone story

The GitHub remote/repo may be named SmartRadio. Clone into the local directory **`subwave-ai`**:

```bash
git clone <repo-url> subwave-ai
cd subwave-ai
sudo ./install.sh
```

`install.sh` checks OS/arch/resources, creates persistent directories, writes `.env` / `config/subwave.yaml` / `secrets/` from **your** answers (no hard-coded production IPs, credentials, or model names), installs Node dependencies, builds the web UI, and installs systemd units **or** Compose.

Ollama is **external**. The installer never installs, updates, pulls, or otherwise manages Ollama or any LLM weights.

After install it prints the web UI URL (API + UI on the same origin when `apps/web/dist` exists).

## Live environment examples (A3 — do not hard-code)

Documented so operators can fill yaml/env on an Oracle aarch64 Linux VM. **Do not** treat these as installer defaults.

| Setting | Example |
| --- | --- |
| Arch / OS | aarch64 Linux (Oracle VM) |
| SUB/WAVE | 1.16.0 at `http://127.0.0.1:7700`, API base `/api` → `SUBWAVE_RADIO_URL=http://127.0.0.1:7700/api` |
| SUB/WAVE health | `GET http://127.0.0.1:7700/api/health` → `{"status":"on-air"}`; also `/api/state`, `/api/now-playing` |
| Ollama | `OLLAMA_BASE_URL=http://100.119.17.28:11434` (v0.34.0 over Tailscale). Set `OLLAMA_MODEL` yourself — do not hard-code `qwen3:8b` even if that tag exists. |
| Downloads / landing | `SUBWAVE_DOWNLOADS_DIR=/music/downloads` (acquisition landing/staging) |
| Library | `SUBWAVE_LIBRARY_DIR=/music/library` (final library; Navidrome discovers files here) |
| Acquisition | **No daemon on Oracle today.** Leave slskd URL/key unset or `verify_status: unverified`. Doctor reports `acquire_unavailable`. |

Navidrome is **passive** on the happy path: once a validated track is in `/music/library`, the existing ~1 minute scanner indexes it. Do not configure SmartRadio as if it must call `startScan` for production ingest. Admin scan remains optional ops.

Playback handoff uses verified SUB/WAVE admin `/dj/search` + `/dj/queue-track` under the opaque `/api` base URL. `REQUEST_ACCEPTED` / `TRACK_READY` notify HTTP is **SERVER INSPECTION REQUIRED** — not configured here, not invented.

## Modes

| Mode | When | Music / data |
| --- | --- | --- |
| `./install.sh` (systemd, default) | Linux host with Node 20+ | Host paths under `data/` or `SUBWAVE_LIBRARY_DIR` / `SUBWAVE_DOWNLOADS_DIR` |
| `./install.sh --mode compose` | Docker available | **Required** host mounts: `SUBWAVE_DATA_DIR`, `SUBWAVE_LIBRARY_DIR`, `SUBWAVE_SECRETS_DIR`. Point host dirs at `/music/library` and `/music/downloads` when that is the live layout. |

Compose never stores the library only in an ephemeral container layer.

Non-interactive:

```bash
sudo ./install.sh --non-interactive
# supply SUBWAVE_* / OLLAMA_* / NAVIDROME_* / SLSKD_* in the environment or `.env`
```

`--force` replaces **this project's** systemd units. It will not rewrite unrelated host services.

## Ops scripts

| Script | Purpose |
| --- | --- |
| `./install.sh` | First install |
| `./update.sh` | `git pull`, `pnpm install`, rebuild UI, restart this project's services |
| `./uninstall.sh` | Stop this project's units/compose. `--purge --force` deletes clone data/secrets/.env only |
| `./backup.sh` | Archive config, secrets, SQLite. `--include-library` adds music (large) |
| `./restore.sh [--force] backup.tar.gz` | Extract into the `subwave-ai` clone |
| `./doctor.sh` | Host + API diagnostics (`GET /api/v1/doctor`), including `acquire_unavailable` |

## Local development (no installer)

```bash
cp .env.example .env
cp config/subwave.example.yaml config/subwave.yaml
mkdir -p secrets data/downloads data/staging data/library
# write secret files listed in secrets/README.md
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @subwave-ai/web test
pnpm dev:api          # 127.0.0.1:8788
pnpm --filter @subwave-ai/web dev   # Vite proxies /api
pnpm dev:worker
```

OpenAPI: `http://127.0.0.1:8788/api/v1/docs`

Relative `./data/downloads` and `./data/library` in the example yaml are **local-dev placeholders**, not the Oracle live paths.

## Health

- `GET /api/v1/health` — process up
- `GET /api/v1/ready` — SQLite readable
- `GET /api/v1/doctor` — config, providers, disk, notes (Ollama remains `external-only`; acquisition gap is `acquire_unavailable`)
- `./doctor.sh` — same plus systemd/disk/CLI checks
