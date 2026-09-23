# Optional external slskd

SmartRadio does not install slskd and does not put it in the SmartRadio image or in `deploy/docker-compose.yml`. A portable example lives in [`deploy/slskd/`](../deploy/slskd/README.md): official `slskd/slskd` (or `ghcr.io/slskd/slskd`) for linux/amd64 and linux/arm64, started with `deploy/slskd/install-slskd.sh`. Nothing in that directory is an Oracle requirement. First-host path examples are comments only: completed downloads `/music/downloads`, library `/music/library`.

The runnable compose file mounts three host paths: completed downloads (the same directory as SmartRadio `paths.downloads`), a separate incomplete directory, and persistent config/state. It does not mount or write the library.

Soulseek username and password are slskd secrets in `deploy/slskd/.env` only (`.env.example` is empty placeholders). They are not SmartRadio config and they are not files under `secrets/`.

The API key (16–255 characters) is generated into `deploy/slskd/.env` when missing. The owner pastes it into the setup UI, which writes `secrets/slskd_api_key`. The UI never displays the saved value.

## Paths

| slskd directory | What to point it at |
| --- | --- |
| Completed downloads | The same directory SmartRadio uses as `paths.downloads` |
| Incomplete downloads | A different directory |
| Config/state | A directory of its own (`/app` in the container) |
| Library | Do not give slskd the SmartRadio library path as a place it writes (downloads, incomplete, or shares) |

`install-slskd.sh` creates missing directories as mode `0750`. It does not make an existing music directory world-writable. Match `SLSKD_UID` / `SLSKD_GID` to the account that should own new files. See [deploy/slskd/README.md](../deploy/slskd/README.md).

## Ports

Confirm the ports that are actually listening. Upstream defaults, and the defaults in `deploy/slskd`:

- API `5030` (SmartRadio). The example binds it to `127.0.0.1` until you change `SLSKD_HTTP_BIND`.
- Optional HTTPS UI `5031`. Often closed until TLS is configured. SmartRadio does not call it.
- Soulseek listen `50300`.

## Phase B/C handoff

After slskd is up, the owner configures SmartRadio. This example does not search or enqueue downloads.

1. Set SmartRadio `SLSKD_URL` to the HTTP base, for example `http://127.0.0.1:5030` on the same host. The process uses that value as `acquisition.base_url`.
2. In the setup wizard or Settings, enable acquisition, choose provider `slskd`, and paste the API key from `deploy/slskd/.env`. That write goes to `secrets/slskd_api_key`.
3. Set Downloads to the same host path as `SLSKD_DOWNLOADS_DIR`. Do not point slskd at the library path.
4. Save, then **Test connection**.

Test connection only calls `GET /api/v0/application` and `GET /api/v0/server` with header `X-API-Key`. It does not search or download. The UI shows one of: Acquisition disabled, Not configured, Unreachable, Auth failed, Reachable, Soulseek not connected, Soulseek not logged in, Ready.

`Ready` is the only result that saves `acquisition.verify_status: verified`. Filling in the URL and key does not.

Restart the SmartRadio worker after a successful test. It reads acquisition config when the process starts.

## Stop without deleting music

```bash
./deploy/slskd/install-slskd.sh --down
```

That stops project `smartradio-slskd` and leaves the completed-downloads directory, incomplete directory, slskd state, and the library in place.

Sketches under `deploy/examples/slskd/` are not this installer. Use `deploy/slskd/` when you want a compose file that persists `/app` and an installer that creates directories and an API key.
