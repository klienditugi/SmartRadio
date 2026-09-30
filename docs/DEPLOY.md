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

Ollama is **external**. The installer never installs, updates, pulls, or otherwise manages Ollama or any LLM weights. Navidrome, SUB/WAVE, and Ollama URL/user/password/model values may be left empty on first boot. Empty is the same as unset. The API starts and reports those integrations as `not_configured` until the setup wizard or `.env` fills them in. `unreachable` is a later live-probe result, not a missing setting.

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
| LLM / library / radio | A blank config does not call Ollama, Navidrome, or SUB/WAVE (`not_configured`). `verified` is a stored test-connection result, never a yaml or env `verify_status`. A filled config without a matching `ready` row is `configured_unverified`: “configured but unverified, run test connection” in `GET /api/v1/doctor` (printed by `./doctor.sh`). |
| Acquisition | **No daemon on Oracle today.** Leave slskd disabled or the URL/key unset. `verified` is a stored test-connection result. An install whose yaml said `verified` shows `configured_unverified` until test-connection is run again. Doctor reports `acquire_unavailable` until then. |

Navidrome is **passive** on the happy path: once a validated track is in `/music/library`, the existing ~1 minute scanner indexes it. Do not configure SmartRadio as if it must call `startScan` for production ingest. Admin scan remains optional ops.

Playback handoff uses verified SUB/WAVE admin `/dj/search` then `/dj/queue-track` under the opaque `/api` base URL (`id` and `title` required; `artist` / `album` optional; HTTP 409 = never-play). `REQUEST_ACCEPTED` / `TRACK_READY` use admin `POST /dj/say` with `mode: "styled"` and context text only. The radio base URL and admin password come from config and `secrets/`. This repository does not deploy to Oracle.

## Modes

| Mode | When | Music / data |
| --- | --- | --- |
| `./install.sh` (systemd, default) | Linux host with Node 20+ | Host paths under `data/` or `SUBWAVE_LIBRARY_DIR` / `SUBWAVE_DOWNLOADS_DIR` |
| `./install.sh --mode compose` | Docker available | **Required** host mounts: `SUBWAVE_DATA_DIR`, `SUBWAVE_LIBRARY_DIR`, `SUBWAVE_SECRETS_DIR`. Point host dirs at `/music/library` and `/music/downloads` when that is the live layout. |

The two modes are exclusive. `install.sh` records the choice in `.subwave-install-mode` (`systemd` or `compose`, gitignored). `sudo ./update.sh` restarts that mode only.

- A systemd install is `subwave-api.service` and `subwave-worker.service`. Update restarts those units. It does not run Compose for this repo, including when Docker is installed for something else.
- A Compose install is the `subwave-ai` project in `deploy/docker-compose.yml`. Update rebuilds that project only.
- slskd is a different compose project, `smartradio-slskd` (`deploy/slskd/`). It is not this app. Docker being installed, or that project running, does not make this a Compose install.

On a systemd install, `./update.sh` must be run as root (`sudo ./update.sh`). If it is not root, it exits and says to re-run with sudo. It does not start Compose instead.

`sudo ./update.sh` and `sudo ./install.sh` run `pnpm install` and the web build as the owner of the clone (`stat -c %U` of the repo root, via `runuser` or `sudo -u`). Existing `node_modules` directories and `apps/web/dist` are given back to that owner first, so a previous root build can be rewritten. The same root update chowns `.git` back to that owner and runs every `git` command as that user, including `fetch`, `pull`, and the read-only `rev-parse` that prints the deployed commit (and the commit named if health never returns 200). A later non-root pull is not blocked by root-owned files in `.git`. `.env`, secrets, config, and data are not chowned.

Before a start or restart, if the API port (`SUBWAVE_API_PORT`, otherwise `server.port` in the config file, otherwise 8788) is held by a process that is not the unit or container being restarted, the script stops and names that process. It does not kill it.

Created or Exited containers left over from the `subwave-ai` project are reported with the command to remove them. They are not deleted. Running `subwave-ai` containers on a systemd install stop the update. `smartradio-slskd` is not inspected or changed.

After a systemd restart the script checks that both units are active and that `GET /api/v1/health` returns 200, and it prints the deployed commit. If `systemctl restart` of `subwave-api.service` or `subwave-worker.service` fails, the script stops and names that unit. It tells you to check `journalctl -u <unit>` and `systemctl status <unit>`. It does not start Compose.

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
| `sudo ./update.sh` | On a host: `git pull`, `pnpm install`, rebuild UI, restart the recorded mode only (systemd units or the `subwave-ai` compose project, never both). Not a manual git pull plus restart. Does not touch slskd. |
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

## Optional external slskd

SmartRadio does not install or contain slskd. `./install.sh` and the app image do not start it. The deployment definition is `deploy/slskd/` (`slskd/slskd:0.26.0`, `install-slskd.sh`; see `docs/SLSKD.md`). `deploy/examples/slskd/` only points there. Completed downloads must be the directory SmartRadio uses as `paths.downloads`. Incomplete downloads stay on a different directory. slskd must not write the library directory. Soulseek username and password are slskd secrets in that example's `.env`, not SmartRadio settings.

Same host: `SLSKD_URL=http://127.0.0.1:5030` when the API is bound to loopback, and SmartRadio's downloads path is the same host path as `SLSKD_DOWNLOADS_DIR`. Remote slskd: `SLSKD_URL` is the HTTP base this host can reach, the API key is pasted into the setup UI (`secrets/slskd_api_key`), and completed files must be readable at `paths.downloads`. Those values stay in `.env` and the setup UI.

After install, and again after `sudo ./update.sh`, run **Test connection** in the setup wizard or Settings. It is read-only. `verified` is stored only when it reports Ready (see `docs/SLSKD.md`). Restart the worker after that. `./update.sh` does not mark acquisition verified.

## Health

- `GET /api/v1/health` — process up
- `GET /api/v1/ready` — SQLite readable
- `GET /api/v1/doctor` — config, providers, disk, notes (Ollama remains `external-only`; acquisition gap is `acquire_unavailable`)
- `./doctor.sh` — same plus systemd/disk/CLI checks
