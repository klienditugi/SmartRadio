# Optional external slskd

SmartRadio does not install slskd and does not put it in the SmartRadio image or in `deploy/docker-compose.yml`. The deployment definition is [`deploy/slskd/`](../deploy/slskd/README.md): image `slskd/slskd:0.26.0` (linux/amd64 and linux/arm64; override with `SLSKD_IMAGE`), started with `deploy/slskd/install-slskd.sh`. `./install.sh` does not start it. `deploy/examples/slskd/` only points at that directory.

Run slskd yourself, then enter its HTTP base URL and API key in the SmartRadio setup wizard or Settings. Use **Test connection** there. That action only calls `GET /api/v0/application` and `GET /api/v0/server` with header `X-API-Key`. It does not search or download.

Soulseek username and password are slskd settings. In the compose example they live only in `deploy/slskd/.env` (empty placeholders in `.env.example`). They are not SmartRadio config and they are not files under `secrets/`.

The API key (16–255 characters) is written to `secrets/slskd_api_key`. The UI can replace it. It never displays the saved value. `install-slskd.sh` generates a key into `deploy/slskd/.env` when that value is empty, and does not print it. Paste it into the setup UI.

## Paths

| slskd directory | What to point it at |
| --- | --- |
| Completed downloads | The same directory SmartRadio uses as `paths.downloads` |
| Incomplete downloads | A different directory |
| Config/state | Its own directory (`/app` in the `deploy/slskd` container). Not the library. |
| Library | Do not give slskd the SmartRadio library path as a place it writes (downloads, incomplete, or shares). The compose file has no library volume. |

Host paths belong in `deploy/slskd/.env` (`SLSKD_DOWNLOADS_DIR`, `SLSKD_INCOMPLETE_DIR`, `SLSKD_APP_DIR`) and in SmartRadio config (`paths.downloads`, `SUBWAVE_DOWNLOADS_DIR`). `./downloads` in the example is a local placeholder. `install-slskd.sh` creates missing directories as mode `0750`, refuses a library path, and does not make an existing directory world-writable.

## Same host or a remote slskd

SmartRadio uses `SLSKD_URL` (it overrides `acquisition.base_url` when the process starts), `secrets/slskd_api_key`, and `paths.downloads`. Application code does not choose a host, an address, or a directory.

**Same host.** Leave `SLSKD_HTTP_BIND` at `127.0.0.1`. Set `SLSKD_URL` to `http://127.0.0.1:5030`, or to the `SLSKD_HTTP_PORT` you set. Paste `SLSKD_API_KEY` from `deploy/slskd/.env` into the setup wizard or Settings. Set the downloads directory to the same host path as `SLSKD_DOWNLOADS_DIR`.

**Remote slskd.** Set `SLSKD_HTTP_BIND` so the SmartRadio host can open the API, and set `SLSKD_URL` to that HTTP base. Do not append `/api/v0`. The API key is still created on the slskd host and pasted into SmartRadio. Completed files must be readable at SmartRadio `paths.downloads`. Point `SLSKD_DOWNLOADS_DIR` at slskd's view of that shared directory and `SUBWAVE_DOWNLOADS_DIR` at SmartRadio's view. The path strings can differ. They must be the same files. Do not mount the library into slskd.

If SmartRadio runs in Docker, `SLSKD_URL` has to be an address that container can route. `127.0.0.1` inside the container is not the host.

## What to verify

From the host that runs SmartRadio, the base URL saved in Settings must answer:

- `GET {base}/api/v0/application`
- `GET {base}/api/v0/server`

with the same `X-API-Key` stored in `secrets/slskd_api_key`. **Test connection** does that and shows one of: Acquisition disabled, Not configured, Unreachable, Auth failed, Reachable, Soulseek not connected, Soulseek not logged in, Ready.

Run it after you install slskd and point SmartRadio at it, and again after you upgrade SmartRadio. On a host, upgrade with `sudo ./update.sh` (see `docs/DEPLOY.md`). That script pulls, reinstalls dependencies, rebuilds the UI, and restarts this project's services in the mode already installed. systemd and Docker Compose are exclusive: a systemd install restarts `subwave-api.service` and `subwave-worker.service` and does not start the `subwave-ai` compose project, even when Docker is on the host. slskd's own compose project is `smartradio-slskd` (`deploy/slskd/`). It is separate from `deploy/docker-compose.yml`. A manual `git pull` and a service restart is not the update path. `./update.sh` does not call slskd and does not store a verified result.

`Ready` is the only result that stores a verified test-connection. The row lives in the database (`integration_checks`: integration, state, tested_at, and an HMAC-SHA256 fingerprint of the URL, provider, and API key). The HMAC key is `secrets/verification_hmac_key`, not the session secret. The fingerprint is not returned or logged. Yaml or env `verify_status` is ignored. Filling in the URL and key does not verify. An install that was verified by writing `verify_status: verified` into yaml shows `configured_unverified` until test-connection is run again.

slskd's own HTTP port and Soulseek listen port are whatever you set in slskd. The compose example defaults are HTTP `5030` (bind `127.0.0.1`), optional HTTPS `5031`, and listen `50300`. Confirm the ports that are actually listening, including that peers can reach the listen port if you want inbound Soulseek connections. Those ports are not SmartRadio requirements.

Restart the SmartRadio worker after a successful test, including when `./update.sh` already restarted it before Test connection. It reads acquisition config when the process starts.

## Which search file is downloaded

Selection does not call an LLM. The slskd adapter maps search JSON into a provider-neutral `CandidateTrack`. This is web radio, not an archive. A normal file is about 20 to 30 MiB. The selector rejects anything that should not play, then compares the survivors in a fixed order and stops at the first difference. It does not add weights.

The same payload and settings always pick the same file. The last two comparisons are username, then path.

Keys live under `acquisition.selection` (see `config/subwave.example.yaml`). Sizes are MiB. 1 MiB = 1,048,576 bytes. The `_mb` key names stay as they are. The settings screen edits version preference, format preference, and the duration cap. It does not show preferred max file size or preferred max duration. Version and format are dropdowns. Each field reports `source`: `env`, `yaml`, or `default`. A value set in the environment is read-only in the UI and a different value is rejected with 409. An invalid enum is rejected with 400.

Optional env overrides: `SLSKD_MAX_FILE_SIZE_MB`, `SLSKD_MIN_FILE_SIZE_MB`, `SLSKD_PREFERRED_MAX_FILE_SIZE_MB`, `SLSKD_MAX_DURATION_SECONDS`, `SLSKD_PREFERRED_MAX_DURATION_SECONDS`, `SLSKD_VERSION_PREFERENCE`, `SLSKD_FORMAT_PREFERENCE`, `SLSKD_MAX_SAMPLE_RATE`, `SLSKD_MAX_BIT_DEPTH`.

`preferred_max_file_size_mb` and `preferred_max_duration_seconds` are still accepted so older yaml loads. The selector ignores them. `SLSKD_EXTENDED_VERSION_BONUS`, `SLSKD_LOSSLESS_PREFERENCE`, and the yaml keys `extended_version_bonus` and `lossless_preference` are ignored. Doctor prints a deprecation note that names the replacement key.

### Hard rejects

These run before ranking. Each removed file increments one reason. The dry-run prints the counts.

Files in `lockedFiles`, or with `isLocked: true`, are never chosen. Real slskd puts locked hits only in `lockedFiles`, often with `isLocked: false`. Those rows are still mapped as locked. An empty `extension` uses the filename. A junk extension such as `flac@synoeastream` is ignored and the filename is used instead. A basename that starts with `._`, or any path segment named `__MACOSX`, is junk.

A file smaller than `min_file_size_mb` (default 1 MiB) is rejected. The adapter does not hand the selector a file with no positive size, so an unknown size never gets a special score. A file larger than `max_file_size_mb` (default 30 MiB) is rejected. There is no graded size curve. `files.max_bytes` is a separate byte count. Existing installs that copied an older example with `max_file_size_mb: 200` should set `acquisition.selection.max_file_size_mb` to 30. Doctor warns when the resolved value is above 30. That warning is not an error, and the process still starts.

`max_duration_seconds` (default 1200) applies when the file reports a duration. Null disables it. A missing duration is not over the cap and is not a short recording. `max_sample_rate` (default 48000 Hz) and `max_bit_depth` (default 24) reject a file that reports a higher value. A file that omits the field stays eligible.

Wrong artist or title:

- The title is a contiguous phrase, not a bag of words. The basename and the title are normalized the same way before the comparison: lowercase, punctuation (underscores, dots, hyphens, brackets) turned into spaces, whitespace collapsed. The same normalization is used for the artist. The phrase must start at a boundary in the original basename. A boundary is the start of the name, the text right after a leading track number (`08 `, `08-`, `201-`, `1 - `, `10A - 117 - `, or a number that leads the following text such as `_08_`), the text right after an artist separator (` - `, `-`, `_-_`, `–`), the text right after `(` or `[`, or the text right after a closing `)` or `]` and its trailing whitespace. The title may also start directly after the requested artist name in the normalized basename, as in `Daft Punk get lucky`. The boundary is chosen on the original string, then the normalized slice is compared, except the artist-name boundary, which is read on the normalized basename. Anything after the phrase is allowed. `You Get Lucky` and `Independant Woman X Get Lucky` do not match, because the phrase does not start at a boundary. A folder supplies the title only when the basename does not carry the phrase at all.
- A medley is rejected when the basename or the album folder uses the word medley / megamix, or names at least two other titles beside this one, joined by ` _ `, ` / `, ` | `, ` + `, or a tight hyphen whose next title starts with a capital letter (`Get Lucky-Freak Out-Another Star`). One extra piece is not enough, including one tight hyphen (`Get Lucky-You Should Be Dancing`). A repeated title, a bare underscore used as a space, a track number, the artist, a feat / ft / and / & credit, and a version marker are not another title. Spaced ` - ` is not a medley separator, and neither is a lowercase hyphen (`daft_punk-get_lucky`, `my-free-mp3`). The basename is also a medley when it contains the whole word or phrase `mashup`, `mash up`, `mash-up`, `segue`, `transition`, `vs`, `vs.`, or `versus`. That word check is the basename only, with one exception: when the basename does not name the artist and a folder segment does, whole-word `vs` or `versus` in that same segment is a medley. A `vs` folder that does not carry the artist does not count, and a basename that already names the artist is unchanged. `edit`, `remix`, `x`, `feat`, and `ft` by themselves do not reject the file. `bootleg` is an unaccepted version.
- The requested artist anywhere in the basename counts, in first, middle, or last position. The same punctuation normalization applies, so `daft_punk` counts. The exception is a different artist leading the basename while this artist appears there only inside `Tribute to X`, `X Cover`, `Originally by X`, `in the style of X`, or `made famous by X`, or only as a bare bracket credit such as `[Daft Punk]` or `(Daft Punk)` with no version word (`remix`, `mix`, `club`, `extended`, `edit`, `re-edit`, `rework`, `dub`, or `bootleg`) in that bracket or elsewhere in the basename. That file is `tribute_or_cover`. A remixer-first name that says remix, club, extended, or edit stays. The word `cover` or `covers` as a whole word in the basename is also `tribute_or_cover`, even when the requested artist leads (`Cover`, `Cover Mix`, `cover by X`, `X cover`). The same whole word in any folder segment is `tribute_or_cover`. `Discover` and `Coverage` do not match. An image such as `cover.jpg` is not an audio file. A different artist leading the basename, with this artist only in folders, is `artist_mismatch`. Another tribute or playlist word in a folder alone does not reject the file.

Stems (an instrument-part basename, or stem / acapella terms the request did not ask for), a long-recording phrase, and a bitrate under 128 kbps are rejects. The whole word `drumless` in the basename or any folder segment is the same stem reject. It is not a version class. A basename that lands in class `other` (live, instrumental, karaoke, demo, a bare mix, or a dangling edit) is rejected as `unaccepted_version`. The same reject applies to a basename whole word `intro`, `outro`, `instrumental`, `recut`, `re-cut`, or `bootleg`, and to a whole word `2k` plus two digits (`2k17`). Those labels reject even when the name also says remix, club, extended, radio edit, album, or original. A folder does not trigger them. A basename with no version label stays original. 128 kbps itself is kept and ranked as poor. A short recording uses the old detector and is now a reject: under 90 seconds, or under 0.6 of the median once five known lengths exist. That median is the matching copies of the song, including the other format, so a 105 second remix FLAC is still short under `flac_only`. `short_recording_penalty` of 0 turns that reject off. The magnitude is not a score.

`mp3_only` and `flac_only` stay hard filters. They are not relaxed when nothing remains.

If every candidate is removed, selection returns no file. The worker moves the request `QUEUED` → `FAILED` with `no_suitable_result` and the reason counts. It does not enqueue. That is not the `acquire_unavailable` path, which is only for an unverified acquisition provider. A search with zero responses is `no usable search result`.

### Ranking

Survivors are compared in this order. The first difference wins.

1. The explicit requested version matches. Naming a version in the request turns the saved preference off.
2. Version class, from the basename only. A folder does not set the class and does not satisfy an explicit request. The default (`balanced`) ranks remix, club, and extended as equal and first, then album or original (an unmarked file counts here), then radio edit, then anything else. A saved `original`, `radio_edit`, `extended`, or `remix` moves that class to the front. The rest keep the default order. An explicit request turns the saved preference off and ranks that class first. An unmarked file is original, and it is not an explicit Original Mix match. A plain club mix is extended. The most derived marker wins, so `original vocal club remix edit` is a remix and `Radio Edit - X Remix` is a remix.
3. Quality. Acceptable beats poor. Acceptable is 192 kbps or more CBR, an MP3 VBR average around 170 kbps or more, or lossless FLAC. Poor is 128 to 191 kbps CBR, and MP3 VBR under that 170 line. An MP3 with no usable bitrate uses size and length when both are known, and is poor otherwise. 192, 256, and 320 are the same band.
4. Format. `prefer_mp3` is the default. `prefer_flac` prefers FLAC only among files that already survived, all of which are at or under the size cap. `auto` does not prefer a format.
5. Peer: a free upload slot, then a shorter queue, then a higher upload speed.
6. Username, then path.

| Class | How the name is read |
| --- | --- |
| `radio_edit` | radio edit, radio version, radio mix, single edit, single version. Cleared when a derived marker is also present. |
| `original` | original mix, original version, original, album version, or a clean title with no version term. Cleared when a derived marker is also present. |
| `extended` | extended, extended mix, extended version, club mix, 12 inch. A plain club mix stays here. |
| `remix` | remix, rmx, mashup, vs, mixshow, rework, re-edit, mix by, mixed by, and a named `<name> edit` / `<name> version` that is not radio, single, album, original, or extended. |
| `other` | live, instrumental, karaoke, demo, a bare mix, or a dangling edit. This is rejected as `unaccepted_version` before ranking. A folder word does not set the class. |

`titleMatch` is 1 when the title tokens are in the basename or a folder, and 0 when no title was passed or the path lacks them. `artistInPath` is 1 when the artist tokens are in the path. Both are printed on the dry-run row. They are not ranking weights. A wrong title is rejected before ranking.

A pick stores `{ breakdown, total, signals, versionClass }` on the accepted request. The breakdown is a set of 0/1 flags for the log. Ranking does not add them up. `signals.quality` is `reported`, `derived`, or `unknown`.

### Defaults

| Setting | Default | Role |
| --- | --- | --- |
| `min_file_size_mb` | 1 MiB | Hard floor. Null disables it. |
| `max_file_size_mb` | 30 MiB | Hard reject. Env `SLSKD_MAX_FILE_SIZE_MB`. |
| `preferred_max_file_size_mb` | 30 MiB | Loaded, not used. Kept for older yaml. |
| `preferred_max_duration_seconds` | 720 | Loaded, not used. Kept for older yaml. |
| `max_duration_seconds` | 1200 | Hard reject above 20 min. Null disables it. |
| `version_preference` | `balanced` | Remix, club, and extended first, then album or original, then radio edit. Env `SLSKD_VERSION_PREFERENCE`. |
| `format_preference` | `prefer_mp3` | `prefer_flac` prefers FLAC among survivors. `mp3_only` and `flac_only` filter. Env `SLSKD_FORMAT_PREFERENCE`. |
| `bitrate_floor_kbps` | 192 | CBR at or above this is acceptable. Under 128 kbps is a reject. |
| `short_recording_fraction` | 0.6 | Known duration below this fraction of the median is rejected. |
| `short_recording_min_samples` | 5 | Median fraction applies only with at least this many known lengths. |
| `short_recording_floor_seconds` | 90 | Known duration below this is rejected even without a median. |
| `short_recording_penalty` | −1900 | Any non-zero value keeps the short reject. Zero disables it. |
| `max_sample_rate` | 48000 | Hard cap. Null disables it. |
| `max_bit_depth` | 24 | Hard cap. Null disables it. |

### Metadata the selector will use

From a live slskd 0.26 search for "Daft Punk Get Lucky" (251 responses, 583 files, 483 audio, 33 locked). The selector does not invent a field that was missing.

| Field | What was actually there |
| --- | --- |
| `size` | Present on all 583 files and always positive. The only universal field. |
| `length` | Duration in seconds. On 469 of 483 audio files (97%). Missing on all `.opus` and a few mp3/flac. Range 105–635 s, median 369. 28 tracks run 8–12 min. None are 12 min or longer. |
| `bitRate` | Only on lossy files (mp3/m4a/ogg), 282 files. Never on FLAC or WAV. Usually 128/192/320. Junk outliers include 8 and 2991. A reported rate under 128 kbps is rejected. 128–191 kbps CBR is poor. 192 kbps and up is acceptable, and so is MP3 VBR around 170 kbps or more. The same VBR flag on ogg does not. An MP3 with no usable bitrate uses size and length when both are known. |
| `sampleRate` / `bitDepth` | Only on lossless, 189 files (185 of 190 FLAC, plus WAV). bitDepth is 16 on 107 and 24 on 82. sampleRate is 44.1 kHz on 117, 88.2 kHz on 55, and 96 or 192 kHz on 15. |
| `extension` | Empty on 75%. One leading dot. One junk value (`flac@synoeastream`). The type comes from the filename when the field is empty or junk. Audio by filename: 265 mp3, 190 flac, 16 m4a, 6 ogg, 4 wav, 2 opus, plus video, lyrics, and images. |
| `filename` | Always Windows `\` paths, 1–8 folders deep. 346 start with a share alias like `@@abcde\`. Folder names often hold the only album, artist, or quality text. |
| Peer | All 251 responses. `hasFreeUploadSlot` true on 223. `queueLength` median 0, p90 93, max 44239. `uploadSpeed` median about 1.6 MB/s, and 0 on 7. |
| Audio size | p10 5.7 MiB, median 14.2, p75 41.8, p90 127, max 442. mp3 median 10.5 (max 24). FLAC median 42. |

Long-recording phrases match the basename, and the immediate parent folder. They do not walk deeper folders, and they never match `CD1`, `CD 1`, or `Disc 1`. A bare `mix` does not match, so "Extended Mix" and "Club Mix" are normal tracks. "Mixshow" does match. The default phrase list is `dj set`, `live at`, `live from`, `full album`, `full set`, `podcast`, `radio show`, `radioshow`, `mixshow`, `continuous mix`, `mixed by`, `megamix`, `essential mix`, `concert`, `episode`, and `ep.` plus a number. It is `acquisition.selection.long_recording_phrases`.

A long-recording phrase is a reject, not a penalty. A missing duration does not make a file short and does not trip the duration cap. A file over `max_file_size_mb` is rejected whether or not its duration is known.

The enqueue body is `[{ filename, size }]` using that filename unchanged, including Windows backslashes. slskd search rows have no id. A later transfer matches on username + that exact filename + size. A basename match is used only when exactly one of that user's rows matches the basename and the size.

## Deploy

`deploy/slskd/` is the only slskd deployment definition in this repo: compose file, `.env.example`, and `install-slskd.sh`. The image is `slskd/slskd:0.26.0`. Docker selects linux/amd64 or linux/arm64. Set `SLSKD_IMAGE` for another tag or for `ghcr.io/slskd/slskd:0.26.0`.

```bash
./deploy/slskd/install-slskd.sh --prepare-only
# Soulseek username and password go in deploy/slskd/.env only
./deploy/slskd/install-slskd.sh
```

Stop without deleting music:

```bash
./deploy/slskd/install-slskd.sh --down
```

That runs `docker compose down` for project `smartradio-slskd`. It leaves completed downloads, incomplete downloads, slskd state, and the library in place. There is no library volume.

`deploy/examples/slskd/README.md` points here. Do not add a second compose file.
