# Optional slskd (not part of SmartRadio)

This directory is a portable example for running upstream [slskd](https://github.com/slskd/slskd) next to SmartRadio. `./install.sh`, `deploy/docker-compose.yml`, and the SmartRadio image do not start it and do not copy it into the app image.

No host, cloud, or architecture is required. Docker selects `linux/amd64` or `linux/arm64` from the official manifest (`slskd/slskd`, or `ghcr.io/slskd/slskd` if you set `SLSKD_IMAGE`).

Soulseek username and password are **slskd** secrets. They live only in `deploy/slskd/.env`, which is gitignored. `.env.example` has empty placeholders. SmartRadio never stores them.

## What gets mounted

| Host variable | Container path | Role |
| --- | --- | --- |
| `SLSKD_APP_DIR` | `/app` | Config, database, and other slskd state |
| `SLSKD_DOWNLOADS_DIR` | `/downloads` | Completed downloads. Same directory as SmartRadio `paths.downloads` |
| `SLSKD_INCOMPLETE_DIR` | `/incomplete` | Incomplete downloads. A different directory |

There is no library volume. Do not add the SmartRadio library as a download path, an incomplete path, or a share.

First-host path examples (comments only, not defaults): completed downloads `/music/downloads`, library `/music/library`.

Relative paths in `.env` are relative to this directory. `./downloads` is only a local placeholder. Point `SLSKD_DOWNLOADS_DIR` at the directory SmartRadio already uses.

## UID / GID

The compose file sets Docker `user:` from `SLSKD_UID` and `SLSKD_GID`. The process is not root unless you set those to `0`. Do not also set `PUID` or `PGID`; the image exits if both styles are set.

`install-slskd.sh` fills an empty uid/gid from the account that runs the script. New directories are mode `0750`. The script does not recursively chmod an existing tree and does not add other-write. `SLSKD_UMASK=0000` is refused. The default umask `0022` is owner-write, not world-writable.

slskd must be able to create files in the downloads directory. The SmartRadio worker later reads those files. Use the worker's uid, or a shared group that can read the directory (group-read umask such as `0022` or `0027`, directory not world-writable). A uid mismatch is not fixed by making the tree world-writable.

## Ports to verify

After `up`, confirm what is actually listening. Defaults:

| Port | Role |
| --- | --- |
| `5030` | HTTP API. SmartRadio uses this. Default host bind is `127.0.0.1`. |
| `5031` | Optional HTTPS UI. Often closed until you configure TLS. SmartRadio does not use it. |
| `50300` | Soulseek listen port (TCP). Open it to peers if you want inbound connections. |

```bash
ss -ltn | grep -E ':5030|:5031|:50300' || true
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5030/health
```

`/health` is slskd's own check. It is not SmartRadio's Test connection.

Set `SLSKD_HTTP_BIND=0.0.0.0` only when something off this host, including a SmartRadio container, must reach the API. Then use a URL that container can route, not a hard-coded address.

## Start

```bash
./deploy/slskd/install-slskd.sh --prepare-only
# edit deploy/slskd/.env: SLSKD_SLSK_USERNAME, SLSKD_SLSK_PASSWORD,
# and SLSKD_DOWNLOADS_DIR if ./downloads is not SmartRadio's downloads path
./deploy/slskd/install-slskd.sh
```

`--prepare-only` copies `.env.example` to `.env` (mode `600`), generates `SLSKD_API_KEY` when it is empty (16–255 characters, not printed), and creates the three directories. It does not invent a Soulseek username or password. The second command refuses to start until those two values are set, then runs `docker compose up -d`.

Equivalent, after `.env` is filled:

```bash
docker compose -f deploy/slskd/docker-compose.yml --env-file deploy/slskd/.env up -d
```

## Phase B/C handoff

This package only gets slskd running. It does not search or enqueue downloads.

When the container is up, the owner configures SmartRadio and runs **Test connection**:

1. In SmartRadio's `.env`, set `SLSKD_URL` to the HTTP base, for example `http://127.0.0.1:5030` when both run on the host. No `/api/v0` suffix is required. `SLSKD_URL` overrides `acquisition.base_url` when the process starts.
2. Open the setup wizard or Settings. Enable acquisition and set the provider to `slskd`.
3. Paste `SLSKD_API_KEY` from `deploy/slskd/.env` into the API key field. The UI writes `secrets/slskd_api_key` and does not display the saved value. Leave Soulseek username and password out of SmartRadio.
4. Set the downloads directory to the same host path as `SLSKD_DOWNLOADS_DIR`. The library directory stays SmartRadio's library.
5. Save, then **Test connection**. That action is read-only (`GET /api/v0/application` and `GET /api/v0/server` with `X-API-Key`). Saving the form does not mark acquisition verified. `verified` is stored only when the probe is Ready: reachable, authentication ok, application `version` present, Soulseek connected and logged in.
6. Restart the SmartRadio worker after a successful test so it reloads that config.

## Stop without deleting music

```bash
./deploy/slskd/install-slskd.sh --down
```

That is `docker compose down` for project `smartradio-slskd`. It does not remove the completed-downloads directory, the incomplete directory, slskd state, or the library. Do not add `-v` in order to “clean music”; these paths are host bind mounts, and the library is not one of them.
