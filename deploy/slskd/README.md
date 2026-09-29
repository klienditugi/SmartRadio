# Optional slskd (not part of SmartRadio)

This directory is a portable example for running upstream [slskd](https://github.com/slskd/slskd) next to SmartRadio. `./install.sh`, `deploy/docker-compose.yml`, and the SmartRadio image do not start it and do not copy it into the app image.

No host or cloud is required. The image is pinned to `slskd/slskd:0.26.0`. Docker selects `linux/amd64` or `linux/arm64` from that manifest. Set `SLSKD_IMAGE` to override the tag or registry (for example `ghcr.io/slskd/slskd:0.26.0`).

Soulseek username and password are **slskd** secrets. They live only in `deploy/slskd/.env`, which is gitignored. `.env.example` has empty placeholders. SmartRadio never stores them.

## What gets mounted

| Host variable | Container path | Role |
| --- | --- | --- |
| `SLSKD_APP_DIR` | `/app` | Config, database, and other slskd state |
| `SLSKD_DOWNLOADS_DIR` | `/downloads` | Completed downloads. Same directory as SmartRadio `paths.downloads` |
| `SLSKD_INCOMPLETE_DIR` | `/incomplete` | Incomplete downloads. A different directory |

There is no library volume. Do not add the SmartRadio library as a download path, an incomplete path, or a share.

Comments in `.env.example` mention `/music/downloads` and `/music/library` only as the live-layout examples already in `docs/DEPLOY.md`. They are not defaults.

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

Set `SLSKD_HTTP_BIND=0.0.0.0` only when something off this host, including a SmartRadio container, must reach the API. Then set `SLSKD_URL` to an address that process can route. Do not put a host name or address into application code.

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

## Same host or a remote slskd

This package only gets slskd running. It does not search or enqueue downloads. SmartRadio's URL, API key, and downloads path are configuration. See `docs/SLSKD.md` for how a Ready **Test connection** stores `verified`.

**Same host.** Leave `SLSKD_HTTP_BIND` at `127.0.0.1`. In SmartRadio's `.env`, set `SLSKD_URL` to `http://127.0.0.1:5030` (or the `SLSKD_HTTP_PORT` you set). No `/api/v0` suffix. `SLSKD_URL` overrides `acquisition.base_url` when the process starts. Set Downloads to the same host path as `SLSKD_DOWNLOADS_DIR`.

**Remote slskd.** Set `SLSKD_HTTP_BIND` so the SmartRadio host can open the API, and set `SLSKD_URL` to that HTTP base. Paste the API key into the setup UI on the SmartRadio host. Point `SLSKD_DOWNLOADS_DIR` at this machine's view of the completed files and SmartRadio `paths.downloads` (`SUBWAVE_DOWNLOADS_DIR`) at the other machine's view of the same files. The path strings can differ. Do not mount the library.

If SmartRadio itself runs in Docker, `SLSKD_URL` is an address that container can route. `127.0.0.1` inside the container is not this host.

## After install and after upgrade

When the container is up, configure SmartRadio and run **Test connection** in the setup wizard or Settings:

1. Set `SLSKD_URL` and the downloads path for the layout above. Leave the library path as SmartRadio's library.
2. Enable acquisition and set the provider to `slskd`.
3. Paste `SLSKD_API_KEY` from `deploy/slskd/.env` into the API key field. The UI writes `secrets/slskd_api_key` and does not display the saved value. Leave Soulseek username and password out of SmartRadio.
4. Save, then **Test connection**. That action is read-only (`GET /api/v0/application` and `GET /api/v0/server` with `X-API-Key`). Saving the form does not store `verified`. `verified` is stored only when the probe reports Ready. Yaml or env `verify_status` is ignored. The stored row is described in `docs/SLSKD.md`.
5. Restart the SmartRadio worker after a successful test so it reloads that config.

Do the same after a SmartRadio upgrade. On a host, upgrade with `sudo ./update.sh`. That pulls, reinstalls dependencies, rebuilds the UI, and restarts this project's services. A manual `git pull` and a service restart is not the update path. `./update.sh` does not call slskd and does not store `verified`. Run **Test connection** again, and restart the worker after it reports Ready, even if `update.sh` already restarted the worker.

## Stop without deleting music

```bash
./deploy/slskd/install-slskd.sh --down
```

That is `docker compose down` for project `smartradio-slskd`. It does not remove the completed-downloads directory, the incomplete directory, slskd state, or the library. Do not add `-v` in order to “clean music”; these paths are host bind mounts, and the library is not one of them.
