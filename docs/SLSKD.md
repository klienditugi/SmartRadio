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

`Ready` is the only result that stores a verified test-connection. The row lives in the database (`integration_checks`: integration, state, tested_at, and an HMAC-SHA256 fingerprint of the URL, provider, and API key). The HMAC key is `secrets/verification_hmac_key`, not the session secret. The fingerprint is not returned or logged. Yaml or env `verify_status` is ignored. Filling in the URL and key does not verify. An install that was verified by writing `verify_status: verified` into yaml shows `configured_unverified` until test-connection is run again.

slskd's own HTTP port and Soulseek listen port are whatever you set in slskd. Upstream examples are HTTP `5030` and listen `50300`. Confirm the ports you actually configured, including that peers can reach the listen port if you want inbound Soulseek connections. Those ports are not SmartRadio requirements.

Restart the SmartRadio worker after a successful test. It reads acquisition config when the process starts.

## Which search file is downloaded

Selection does not call an LLM. The slskd adapter only maps search JSON into a provider-neutral `CandidateTrack`. The score is a sum of named components. The same payload and settings always pick the same file. Ties break on peer username, then the full path.

Keys live under `acquisition.selection` (see `config/subwave.example.yaml`). The settings screen edits the preferred size, the extended/remix bonus, the preferred duration, the hard duration cap, and the lossless-preference weight. Each of those reports `source`: `env`, `yaml`, or `default`. A value set in the environment is read-only in the UI and a different value is rejected with 409.

Optional env overrides: `SLSKD_MAX_FILE_SIZE_MB`, `SLSKD_MIN_FILE_SIZE_MB`, `SLSKD_PREFERRED_MAX_FILE_SIZE_MB`, `SLSKD_MAX_DURATION_SECONDS`, `SLSKD_PREFERRED_MAX_DURATION_SECONDS`, `SLSKD_EXTENDED_VERSION_BONUS`, `SLSKD_LOSSLESS_PREFERENCE`, `SLSKD_MAX_SAMPLE_RATE`, `SLSKD_MAX_BIT_DEPTH`.

### Hard filters

Files in `lockedFiles`, or with `isLocked: true`, are never chosen. An empty `extension` uses the filename. A junk extension such as `flac@synoeastream` is ignored and the filename is used instead. A basename that starts with `._`, or any path segment named `__MACOSX`, is junk (`\` and `/`, case-insensitive). Files smaller than `min_file_size_mb` (default 1, in 1024×1024-byte units) or larger than `max_file_size_mb` (default 200, same unit as `files.max_bytes`) are excluded. `max_duration_seconds` (default 1200) applies when the file reports a duration; null disables it. Files that omit duration stay eligible. `max_sample_rate` (default 48000 Hz) and `max_bit_depth` (default 24) are broadcast-friendly. A file that reports a sample rate or bit depth above its cap is excluded. A file that does not report that field stays eligible. Set a cap or the size floor to null to disable it.

`preferred_max_file_size_mb` (default 30) and `preferred_max_duration_seconds` (default 720) are penalties, not exclusions. Each preferred value must be less than or equal to its hard max when the hard max is set.

When the selector is given a request title, every significant title token must appear in the basename or a parent folder. The title is lowercased, diacritics are stripped, punctuation is dropped, and a bracketed `feat.` / `ft.` credit is removed before tokenizing. Stopwords (`a`, `an`, `the`, `and`, `of`, `feat`, `ft`) are ignored unless the title is only stopwords. Single-letter tokens are ignored unless the title has no longer token. Version terms in the title are not required tokens. Artist tokens are not required. A call that omits the title skips this filter. The worker always passes the request artist and title.

If junk, extension, minimum size, maximum size, duration, sample rate, bit depth, title, or `isLocked` remove every candidate, selection returns no file. It does not widen a filter or read `lockedFiles` as a fallback. The worker then moves the request `QUEUED` → `FAILED` with outcome `no_suitable_result` and a reason that counts how many candidates each filter removed (`junk`, `min_file_size`, `title_mismatch`, and the older keys). It does not enqueue a download. A search with zero responses is a different failure, `no usable search result`.

### Score

Every pick stores `{ breakdown, total, signals }` on the `QUEUED` → `DOWNLOADING` event and on `GET /api/v1/requests/:id` as `selection_score`. Nothing in that object is a secret. `signals.quality` is `reported`, `derived`, or `unknown`.

| Component | Default weight | What it measures |
| --- | --- | --- |
| `requestedVersion` | +1000 | The request names a version term and this file matches it. Dominates every other component except hard filters and an incidental stem. |
| `titleMatch` | +12 basename, +4 path only | Title tokens sit in the basename, or only in a folder. 0 when no title was passed. |
| `artistInPath` | +24 | Artist tokens appear in the path. 0 when no artist was passed or the path lacks them. |
| `format` | +36 lossless, 0 lossy | `lossless_preference`. This is the configurable format-balance weight. |
| `quality` | +30 for 16/44.1 or 16/48; +8 more when bit depth or sample rate is higher and still inside the caps; +28 for 256–320 kbps; +22 for 321–500; +8 for the floor up to 255; penalty below the floor (default 192) down to −48 at 32 kbps; 0 when unknown | Reported fields only. Lossy values outside 32–500 kbps are unknown. A derived estimate is half of the reported lossy score and is labeled `derived`. |
| `extendedBonus` | +48, on by default | Path matches remix, extended, or club mix, and the length is normal. |
| `sizeOvershoot` | gentle 12 points per 1.0 ratio above 30 MiB when duration is known and normal, up to ratio 1; then 48 per extra 1.0. Unknown duration, or a duration over the preferred max, uses 48 from the start. Capped at −140 | Not a reason to pick a tiny poor file. Under 30 MiB adds nothing. |
| `durationOvershoot` | −400 × overRatio × (1 + overRatio), capped at −400. A 15 min file against 720 s is −125 | Only when duration is known and above `preferred_max_duration_seconds`. |
| `longRecording` | −280 | Basename or the immediate parent matches a long-recording phrase. |
| `stem` | −1600 | Instrument-part basename, or stem / stems / multitrack / acapella, when the request did not ask for that part. |
| `availability` | +6 free slot, −4 no slot, −1 per 25 queued up to −12, −60 when the queue is over 1000, up to +5 for upload speed | Small, except an extreme queue. A queue of 8 is −1, so it loses to a much faster peer and wins when speed is equal. |

A stem penalty is larger than the requested-version bonus plus every positive component, so an incidental stem stays last. If the request itself names that stem or acapella term, the stem penalty is not applied and the requested version wins. A stem file alone is still eligible. It is not a hard filter.

### Defaults

| Setting | Default | Role |
| --- | --- | --- |
| `min_file_size_mb` | 1 | Hard floor. Null disables it. |
| `preferred_max_file_size_mb` | 30 | Gradual penalty. Env `SLSKD_PREFERRED_MAX_FILE_SIZE_MB`. |
| `max_file_size_mb` | 200 | Hard exclusion. |
| `preferred_max_duration_seconds` | 720 | Penalty above 12 min. |
| `max_duration_seconds` | 1200 | Hard exclusion above 20 min. Null disables it. |
| `extended_version_bonus` | true | Normal-length remix / extended / club mix. |
| `lossless_preference` | 36 | See format balance. 0 prefers the 320 kbps MP3. |
| `bitrate_floor_kbps` | 192 | Lossy rates below this are penalized. |
| `max_sample_rate` | 48000 | Hard cap. Null disables it. |
| `max_bit_depth` | 24 | Hard cap. Null disables it. |

### Format balance

A normal 6-minute 16/44.1 FLAC is about 42 MiB. A 320 kbps MP3 of the same song is about 14 MiB. A size-only penalty would pick the MP3 every time.

Duration is the length signal when it is known. The size penalty stays gentle for a moderate overshoot of a normal-duration file (42 MiB is −5) and grows steeply for a large overshoot or when duration is missing.

**Default decision: the 42 MiB 16/44.1 FLAC beats the 14 MiB 320 kbps MP3.** The FLAC scores format 36 + quality 30 + size −5 = 61. The MP3 scores quality 28. Set `lossless_preference` to 0 and the FLAC scores 25, so the MP3 wins. The same default FLAC also beats a 128 kbps MP3 and an unknown-quality small file.

### Metadata the selector will use

From a live slskd 0.26 search for "Daft Punk Get Lucky" (251 responses, 583 files, 483 audio, 33 locked). The selector does not invent a field that was missing.

| Field | What was actually there |
| --- | --- |
| `size` | Present on all 583 files and always positive. The only universal field. |
| `length` | Duration in seconds. On 469 of 483 audio files (97%). Missing on all `.opus` and a few mp3/flac. Range 105–635 s, median 369. 28 tracks run 8–12 min. None are 12 min or longer. |
| `bitRate` | Only on lossy files (mp3/m4a/ogg), 282 files. Never on FLAC or WAV. Usually 128/192/320. Junk outliers include 8 and 2991. `isVariableBitRate` is set on 67. Values outside 32–500 kbps are unknown. |
| `sampleRate` / `bitDepth` | Only on lossless, 189 files (185 of 190 FLAC, plus WAV). bitDepth is 16 on 107 and 24 on 82. sampleRate is 44.1 kHz on 117, 88.2 kHz on 55, and 96 or 192 kHz on 15. |
| `extension` | Empty on 75%. One leading dot. One junk value (`flac@synoeastream`). The type comes from the filename when the field is empty or junk. Audio by filename: 265 mp3, 190 flac, 16 m4a, 6 ogg, 4 wav, 2 opus, plus video, lyrics, and images. |
| `filename` | Always Windows `\` paths, 1–8 folders deep. 346 start with a share alias like `@@abcde\`. Folder names often hold the only album, artist, or quality text. |
| Peer | All 251 responses. `hasFreeUploadSlot` true on 223. `queueLength` median 0, p90 93, max 44239. `uploadSpeed` median about 1.6 MB/s, and 0 on 7. |
| Audio size | p10 5.7 MiB, median 14.2, p75 41.8, p90 127, max 442. mp3 median 10.5 (max 24). FLAC median 42. |

Long-recording phrases match the basename, and the immediate parent folder. They do not walk deeper folders, and they never match `CD1`, `CD 1`, or `Disc 1`. A bare `mix` does not match, so "Extended Mix" and "Club Mix" are normal tracks (and, when the length is normal, they take the extended bonus). "Mixshow" does match. The default phrase list is `dj set`, `live at`, `live from`, `full album`, `full set`, `podcast`, `radio show`, `radioshow`, `mixshow`, `continuous mix`, `mixed by`, `megamix`, `essential mix`, `concert`, `episode`, and `ep.` plus a number. It is `acquisition.selection.long_recording_phrases`.

When duration is known and at or under 720 s, that is a normal length. When duration is missing, a normal length means no long-recording phrase and a size at or under the preferred max. The extended bonus is applied only then.

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
