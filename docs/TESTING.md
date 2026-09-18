# Testing

## Backend / shared (Vitest, Node)

From the clone root:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @subwave-ai/api openapi   # regenerates docs/openapi.json
```

Covers packages (`core`, `shared`, `db`, `providers`) plus `apps/api` and `apps/worker`.

## Web UI

```bash
pnpm --filter @subwave-ai/web test
pnpm --filter @subwave-ai/web typecheck
pnpm --filter @subwave-ai/web build
```

UI tests use jsdom. They do not call live Navidrome / SUB/WAVE / slskd / Ollama.

## Install / ops scripts

```bash
bash -n install.sh update.sh uninstall.sh backup.sh restore.sh doctor.sh scripts/ops-common.sh
pnpm test   # includes scripts/ops-scripts.test.ts
./doctor.sh # when the API is not running, health is expected to FAIL
```

`install.sh --help` must mention that Ollama is never installed.

## Manual UI check

1. Seed `secrets/admin_password` and `secrets/session_secret`.
2. Copy `config/subwave.example.yaml` → `config/subwave.yaml` and set **your** URLs/model (no repo defaults for live hosts).
3. `pnpm dev:api` and `pnpm --filter @subwave-ai/web dev`.
4. Sign in, open Dashboard, Settings wizard, Requests, Jobs, Disk, Logs.
