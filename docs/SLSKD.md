# Optional external slskd

SmartRadio does not install slskd and does not put it in the SmartRadio image or in `deploy/docker-compose.yml`. Run slskd yourself, then enter its HTTP base URL and API key in the SmartRadio setup wizard or Settings. Use **Test connection** there. That action only calls `GET /api/v0/application` and `GET /api/v0/server` with header `X-API-Key`. It does not search or download.

Soulseek username and password are slskd settings. They are not SmartRadio config and they are not files under `secrets/`.

The API key (16–255 characters) is written to `secrets/slskd_api_key`. The UI can replace it. It never displays the saved value.

## Paths

| slskd directory | What to point it at |
| --- | --- |
| Completed downloads | The same directory SmartRadio uses as `paths.downloads` |
| Incomplete downloads | A different directory |
| Library | Do not give slskd the SmartRadio library path as a place it writes (downloads, incomplete, or shares) |

Placeholders in `deploy/examples/slskd/` are not application defaults. Substitute directories that exist on the host you are using.

## What to verify

From the host that runs SmartRadio, the base URL saved in Settings must answer:

- `GET {base}/api/v0/application`
- `GET {base}/api/v0/server`

with the same `X-API-Key` stored in `secrets/slskd_api_key`. **Test connection** does that and shows one of: Acquisition disabled, Not configured, Unreachable, Auth failed, Reachable, Soulseek not connected, Soulseek not logged in, Ready.

`Ready` is the only result that saves `acquisition.verify_status: verified`. Filling in the URL and key does not.

slskd's own HTTP port and Soulseek listen port are whatever you set in slskd. Upstream examples are HTTP `5030` and listen `50300`. Confirm the ports you actually configured, including that peers can reach the listen port if you want inbound Soulseek connections. Those ports are not SmartRadio requirements.

Restart the SmartRadio worker after a successful test. It reads acquisition config when the process starts.

## Which search file is downloaded

Selection does not call an LLM. Keys live under `acquisition.selection` (see `config/subwave.example.yaml`). Optional env overrides: `SLSKD_MAX_FILE_SIZE_MB`, `SLSKD_MAX_DURATION_SECONDS`, `SLSKD_MAX_SAMPLE_RATE`, `SLSKD_MAX_BIT_DEPTH`. The settings screen does not edit these.

Files in `lockedFiles`, or with `isLocked: true`, are never chosen. An empty `extension` uses the filename. Files larger than `max_file_size_mb` (default 200, in 1024×1024-byte units, same as `files.max_bytes`) are excluded. `max_duration_seconds` applies to slskd `length` when that field is present; leave it unset for no duration limit. `max_sample_rate` (default 48000 Hz) and `max_bit_depth` (default 24) are broadcast-friendly and configurable. A file that reports a sample rate or bit depth above its cap is excluded. A file that does not report that field stays eligible. Set either key to null to disable that cap.

Rank, first difference wins:

1. Extension: `.flac`, `.wav`, `.m4a`, `.mp3`, `.ogg`, then any other allowed extension.
2. Clean version, then a penalized one. The default terms are remix, live, edit, extended, radio edit, instrumental, karaoke, cover, acapella, demo. They match the basename or a parent folder on a word boundary, case-insensitive, unless the request artist or title contains that term.
3. Peer: free upload slot, then `false`, then missing; then a shorter queue (missing last); then a faster upload (missing last).
4. Quality: higher bit depth, then sample rate, then bit rate, among values at or under the caps. Missing bit depth and sample rate are neutral. A sample rate above the cap is not better than the cap. Missing bit rate sorts last.
5. Size closer to the median of the remaining same-extension files.
6. Username, then the full filename.

The enqueue body is `[{ filename, size }]` using that filename unchanged, including Windows backslashes. slskd search rows have no id. A later transfer matches on username + that exact filename + size. A basename match is used only when exactly one of that user's rows matches the basename and the size.

## Example: Compose

`deploy/examples/slskd/docker-compose.example.yml` runs the upstream slskd image next to SmartRadio. It is not started by SmartRadio's compose file.

Set `SLSKD_COMPLETE_DIR` to the SmartRadio downloads directory and `SLSKD_INCOMPLETE_DIR` to a different directory. Set `SLSKD_API_KEY` to the same value you enter in the SmartRadio UI. Set the Soulseek username and password only in that compose environment.

Stop it without deleting music:

```bash
docker compose -f deploy/examples/slskd/docker-compose.example.yml down
```

Do not delete the completed-downloads directory or the library directory.

## Example: systemd

`deploy/examples/slskd/slskd.service.example` and `deploy/examples/slskd/slskd.example.yml` are sketches. Copy them where you keep host units and slskd config, replace the placeholders, then:

```bash
systemctl enable --now slskd
```

Remove the unit without deleting music:

```bash
systemctl disable --now slskd
```

Leave the completed-downloads directory and the library directory in place.
