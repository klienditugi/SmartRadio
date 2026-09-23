# Sub Wave AI (`subwave-ai`)

Operator console + backend for Sub Wave AI Radio Automation.

The GitHub remote/repo is **SmartRadio**. The local clone directory and install path are always **`subwave-ai`**:

```bash
git clone <repo-url> subwave-ai
cd subwave-ai
sudo ./install.sh
```

That is the supported production install path. See [docs/DEPLOY.md](docs/DEPLOY.md).

Ollama is an **external** service. This project never installs, updates, or pulls Ollama or any model (including Qwen). Configure `OLLAMA_BASE_URL` and `OLLAMA_MODEL` only — there is no default model name.

## Layout

```
apps/api          Fastify API + OpenAPI (`127.0.0.1` by default) + optional static UI
apps/worker       Job processors (LLM, library, acquisition, radio, health)
apps/web          Vite/React operator console
packages/core     Request state machine + deterministic station policy
packages/db       SQLite schema, migrations, job lease
packages/providers  Ollama, Navidrome, SUB/WAVE, slskd (verified endpoints only)
packages/shared   Types, config schema, path safety
config/           Example YAML (copy; do not commit live values)
deploy/           systemd units, Docker/Compose (host-mounted music/data)
docs/             Architecture, integration spec, OpenAPI, deploy, RC notes
```

## Production ops

| Script | Role |
| --- | --- |
| `./install.sh` | OS/arch/resource checks, deps, dirs, secrets, systemd or Compose |
| `./update.sh` | Pull, rebuild UI, restart this project's services |
| `./uninstall.sh` | Stop this project only (`--purge --force` removes clone data) |
| `./backup.sh` / `./restore.sh` | Config, secrets, SQLite; optional `--include-library` |
| `./doctor.sh` | CLI diagnostics + `/api/v1/doctor` |

Compose: `./install.sh --mode compose` with host paths `SUBWAVE_DATA_DIR` and `SUBWAVE_LIBRARY_DIR`. Music must not live only in an ephemeral container.

## Local development

```bash
cp .env.example .env
cp config/subwave.example.yaml config/subwave.yaml
mkdir -p secrets data/downloads data/staging data/library
# secrets/admin_password, session_secret, navidrome_password,
# subwave_admin_password, slskd_api_key
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @subwave-ai/web test
pnpm --filter @subwave-ai/web build
```

Terminals:

```bash
pnpm dev:api
pnpm dev:worker
pnpm --filter @subwave-ai/web dev
```

API bind defaults to `127.0.0.1` (`SUBWAVE_API_HOST` / `SUBWAVE_API_PORT`). After a UI build, the API also serves the console from `/`. OpenAPI: `/api/v1/docs`.

## Request states (Amendment A3)

Semantic pipeline:

`REQUESTED` → `CLASSIFYING` → `APPROVED`/`REJECTED` → acquisition/download → `/music/downloads` → validation → `/music/library` → announce/queue through SUB/WAVE

Implementation status `RECEIVED` is semantic `REQUESTED` (the code enum is not renamed). Finer statuses still exist: `CHECKING_LIBRARY`, `ALREADY_AVAILABLE`, `SEARCHING`, `QUEUED`, `DOWNLOADING`, `DOWNLOAD_COMPLETE`, `VALIDATING`, `IMPORTING`, `READY`, plus optional `INDEXING`, `FAILED`, and `CANCELLED`.

Navidrome is **passive** on the happy path: once a validated file is in the library directory, its ~1 minute scanner discovers it. Admin `startScan` is ops-only. Import does not enqueue `index_library`.

Station policy is application code. The LLM never approves tracks, never runs a shell, and never writes config. SmartRadio does not own DJ personality/voice — SUB/WAVE does. `REQUEST_ACCEPTED` and `TRACK_READY` are context sent with `POST /dj/say` (`mode: "styled"`). `TRACK_READY` runs only after search can see the track, and only then is the track queued. Acquisition may stay `acquire_unavailable` (disabled, missing URL/key, or not live-verified); that path does not announce. Admin test-connection is read-only against slskd `/api/v0/application` and `/api/v0/server`. The API key is never returned. Soulseek username and password are not stored here.

Provider contracts: [docs/INTEGRATION.md](docs/INTEGRATION.md). Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Release-candidate gaps: [docs/RELEASE_CANDIDATE.md](docs/RELEASE_CANDIDATE.md). How to run tests: [docs/TESTING.md](docs/TESTING.md).
