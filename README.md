# Sub Wave AI (`subwave-ai`)

Backend foundation for Sub Wave AI Radio Automation.

The Git remote is the SmartRadio repository. Clone the working tree as **`subwave-ai`**:

```bash
git clone <repo-url> subwave-ai
cd subwave-ai
```

Ollama is an **external** service. This project never installs, updates, or pulls Ollama or any model (including Qwen). Configure `base_url` and `model` only.

The React UI and production `install.sh` (install/update/backup/doctor) are owned by Bot4. `./install.sh` in this repo is a stub.

## Layout

```
apps/api          Fastify API + OpenAPI (`127.0.0.1` by default)
apps/worker       Job processors (LLM, library, acquisition, radio, health)
apps/web          Placeholder — Bot4 owns the UI
packages/core     Request state machine + deterministic station policy
packages/db       SQLite schema, migrations, job lease
packages/providers  Ollama, Navidrome, SUB/WAVE, slskd (verified endpoints only)
packages/shared   Types, config schema, path safety
config/           Example YAML
docs/             Architecture, integration spec, OpenAPI
```

## Prerequisites

- Node.js 20+
- pnpm 10+
- An external Ollama daemon if you want live classification (not required for unit tests)

## Configure

```bash
cp .env.example .env
cp config/subwave.example.yaml config/subwave.yaml
mkdir -p secrets data/downloads data/staging data/library
# put secrets in files, not in git:
#   secrets/admin_password
#   secrets/session_secret
#   secrets/navidrome_password
#   secrets/subwave_admin_password
#   secrets/slskd_api_key
```

Set `OLLAMA_MODEL` to whatever model is already present on the external Ollama host. There is no default model name.

Live URLs and credentials stay in yaml / env / `secrets/`. Nothing in source hard-codes IPs, passwords, API keys, ports, or library paths.

## Run API + worker locally

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @subwave-ai/api openapi   # writes docs/openapi.json
```

In two terminals:

```bash
pnpm dev:api
pnpm dev:worker
```

API bind defaults to `127.0.0.1` (`SUBWAVE_API_HOST` / `SUBWAVE_API_PORT`). OpenAPI UI: `http://127.0.0.1:<port>/api/v1/docs`.

The API is sync+enqueue only. Workers own LLM calls, Navidrome, slskd, SUB/WAVE, and live health probes.

Music files flow `downloads → staging → validation → library` on persistent paths. Do not keep the library only in an ephemeral container filesystem.

## Request states

`RECEIVED → CLASSIFYING → REJECTED|APPROVED → CHECKING_LIBRARY → ALREADY_AVAILABLE|SEARCHING → QUEUED → DOWNLOADING → DOWNLOAD_COMPLETE → VALIDATING → IMPORTING → INDEXING → READY` plus `FAILED` and `CANCELLED`. Transitions are enforced in `packages/core` and audited in `request_events`.
