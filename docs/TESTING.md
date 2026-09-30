# Testing

## Backend / shared (Vitest, Node)

From the `subwave-ai` clone root:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @subwave-ai/api openapi   # regenerates docs/openapi.json
```

Covers packages (`core`, `shared`, `db`, `providers`) plus `apps/api` and `apps/worker`.

Acquisition settings and test-connection use a mocked slskd. Those tests call only `GET /api/v0/application` and `GET /api/v0/server`. They do not install slskd or enqueue downloads. `verify_status` stays `unverified` until that probe reports application `version` plus Soulseek connected and logged in.

## Web UI

```bash
pnpm --filter @subwave-ai/web test
pnpm --filter @subwave-ai/web typecheck
pnpm --filter @subwave-ai/web build
```

UI tests use jsdom. They do not call live Navidrome / SUB/WAVE / slskd / Ollama.

Happy-path ingest does **not** require SmartRadio to trigger a Navidrome scan (Navidrome is passive; ~1 minute scanner). Admin scan is ops-only and is not enqueued after import. `RadioProvider.say` (`POST /dj/say`) and the `REQUEST_ACCEPTED` / `TRACK_READY` worker transitions are covered with mocked HTTP and mocked providers — not against a live radio.

## Install / ops scripts

```bash
bash -n install.sh update.sh uninstall.sh backup.sh restore.sh doctor.sh scripts/ops-common.sh deploy/slskd/install-slskd.sh
bash scripts/test-update-mode.sh   # stubbed systemctl/docker; also run by pnpm test
pnpm test   # includes scripts/ops-scripts.test.ts
./doctor.sh # when the API is not running, health is expected to FAIL
```

`scripts/test-update-mode.sh` covers update mode selection. The old `systemctl list-unit-files | grep -q` test is false under `set -o pipefail` when the unit is present (SIGPIPE, exit 141). The harness reproduces that with a stub `systemctl` and a stub `docker`. The replacement is `systemctl list-unit-files --no-legend --no-pager subwave-api.service` with no pipe: exit status 0 and the unit name in the output. A systemd install then restarts units and does not run Compose. The same harness checks that a root update runs `pnpm install` and the web build as the owner of the clone, and chowns `node_modules` and `apps/web/dist` back to that owner without touching secrets, `.env`, config, or data. It also checks that a root update chowns `.git` only and runs every `git` command through `runuser` or `sudo -u`, including read-only `rev-parse` on the post-restart health-success and health-failure paths. A direct `git` invocation under that root run fails the test. A non-root update runs git directly and does not chown. A failed `systemctl restart` of either unit stops with that unit's name and `journalctl -u` / `systemctl status`, and does not start Compose. A pull that changes `scripts/ops-common.sh` re-executes `update.sh` once: the second pass runs the pulled file, does not fetch or pull again, does not start Compose, and keeps the original arguments. An unchanged pull does not re-exec. `SUBWAVE_UPDATE_REEXEC=1` skips the pull.

`install.sh --help` must mention that Ollama is never installed.

## Manual UI check

1. Seed `secrets/admin_password` and `secrets/session_secret`.
2. Copy `config/subwave.example.yaml` → `config/subwave.yaml` and set **your** URLs/model (no repo defaults for live hosts).
3. `pnpm dev:api` and `pnpm --filter @subwave-ai/web dev`.
4. Sign in, open Dashboard, Settings wizard, Requests, Jobs, Disk, Logs.
