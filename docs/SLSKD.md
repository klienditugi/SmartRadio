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

Keys live under `acquisition.selection` (see `config/subwave.example.yaml`). Every size setting — `preferred_max_file_size_mb`, `min_file_size_mb`, `max_file_size_mb`, and the size-curve thresholds derived from the preferred size — is MiB. 1 MiB = 1,048,576 bytes. The `_mb` key names stay as they are. The settings screen edits the preferred size, the version preference, the preferred duration, the hard duration cap, and the format preference. Version and format are dropdowns. Each field reports `source`: `env`, `yaml`, or `default`. A value set in the environment is read-only in the UI and a different value is rejected with 409. An invalid enum is rejected with 400.

Optional env overrides: `SLSKD_MAX_FILE_SIZE_MB`, `SLSKD_MIN_FILE_SIZE_MB`, `SLSKD_PREFERRED_MAX_FILE_SIZE_MB`, `SLSKD_MAX_DURATION_SECONDS`, `SLSKD_PREFERRED_MAX_DURATION_SECONDS`, `SLSKD_VERSION_PREFERENCE`, `SLSKD_FORMAT_PREFERENCE`, `SLSKD_MAX_SAMPLE_RATE`, `SLSKD_MAX_BIT_DEPTH`.

`SLSKD_EXTENDED_VERSION_BONUS`, `SLSKD_LOSSLESS_PREFERENCE`, and the yaml keys `extended_version_bonus` and `lossless_preference` are ignored. They are not translated into the new enums. Doctor prints a deprecation note that names the replacement key.

### Hard filters

Files in `lockedFiles`, or with `isLocked: true`, are never chosen. Real slskd puts locked hits only in `lockedFiles`, often with `isLocked: false`. Those rows are still mapped as locked, so they increment the `locked` filter count and are not a fallback pool. An empty `extension` uses the filename. A junk extension such as `flac@synoeastream` is ignored and the filename is used instead. A basename that starts with `._`, or any path segment named `__MACOSX`, is junk (`\` and `/`, case-insensitive). Files smaller than `min_file_size_mb` (default 1 MiB) or larger than `max_file_size_mb` (default 200 MiB) are excluded. `files.max_bytes` is a separate byte count. `max_duration_seconds` (default 1200) applies when the file reports a duration; null disables it. Files that omit duration stay eligible. `max_sample_rate` (default 48000 Hz) and `max_bit_depth` (default 24) are broadcast-friendly. A file that reports a sample rate or bit depth above its cap is excluded. A file that does not report that field stays eligible. Set a cap or the size floor to null to disable it.

`preferred_max_file_size_mb` (default 30 MiB) and `preferred_max_duration_seconds` (default 720) are penalties, not exclusions. Each preferred value must be less than or equal to its hard max when the hard max is set.

When the selector is given a request title, every significant title token must appear in the basename or a parent folder. The title is lowercased, diacritics are stripped, punctuation is dropped, and a bracketed `feat.` / `ft.` credit is removed before tokenizing. Stopwords (`a`, `an`, `the`, `and`, `of`, `feat`, `ft`) are ignored unless the title is only stopwords. Single-letter tokens are ignored unless the title has no longer token. Version terms in the title are not required tokens. Artist tokens are not required. A call that omits the title skips this filter. The worker always passes the request artist and title.

`format_preference` of `mp3_only` or `flac_only` is a hard filter that runs after the extension allowlist. It has its own `format_preference` count in the `no_suitable_result` reason. There is no relaxation when every file is removed.

If junk, extension, format preference, minimum size, maximum size, duration, sample rate, bit depth, title, or `isLocked` remove every candidate, selection returns no file. It does not widen a filter or read `lockedFiles` as a fallback. The worker then moves the request `QUEUED` → `FAILED` with outcome `no_suitable_result` and a reason that counts how many candidates each filter removed (`junk`, `format_preference`, `min_file_size`, `title_mismatch`, and the older keys). It does not enqueue a download. A search with zero responses is a different failure, `no usable search result`.

### Score

Every pick stores `{ breakdown, total, signals }` on the `QUEUED` → `DOWNLOADING` event and on `GET /api/v1/requests/:id` as `selection_score`. Nothing in that object is a secret. `signals.quality` is `reported`, `derived`, or `unknown`.

Priority, high to low. A higher item is not outweighed by the sum of the realistic ranges below it. Hard filters remove a file before it can score. This is a fun web-radio station, not an archive. Fun version comes first, a sane file size second, and format last. **Owner decision:** once a file is acceptable, the saved version matters more than a higher bitrate or FLAC, so a 128–191 kbps Club Mix beats a 320 kbps Radio Edit under `extended`. A 60–70 MiB file does not win just because it is FLAC.

1. Correct artist and title. Title tokens are a hard filter. Basename (+36) and path-only (+8) points, plus artist in the path (+48), only separate files that already match.
2. Explicit requested version (+12400). Clears the full version-preference range plus the bad-result, quality, size, fidelity, format, and peer ranges. When the request names a version, the saved preference and the fun-style second bonus are both 0 for every file.
3. Saved version preference. Basename +7800, parent folder +5200, clean original +2600, fun-style second bonus +2600. Every one of those clears acceptable quality, the known-duration size penalty through the default hard maximum (200 MiB), extra fidelity, format, peer, and a mild duration overshoot. `balanced` is 0. Off entirely when the request names a version.
4. Avoid bad results. Long recording −1900, short recording up to −1900, duration overshoot up to −400, stem −22000. A known bitrate under 128 kbps, a long-recording phrase, a short-recording hit, a stem, or a duration overshoot that has reached −400 gets no version bonus. Unknown-duration size uses the steeper curve and sits in this tier.
5. Reaching acceptable quality. Below the floor (default 192 kbps) the score is −(800 + a small curve). 191 kbps is −805, 128 kbps is −840, 32 kbps is −864. That cliff clears the known-duration size penalty through the hard maximum, plus fidelity, format, and a normal peer. A rate just under the floor is already enough. Extra fidelity is not part of this tier.
6. File size, when duration is known and normal. 0 through the preferred 30 MiB. Gentle until 1.5× (45 MiB, penalty −96), which is still smaller than fidelity + format + peer, so a better version can win there. From 2× (60 MiB, penalty −240) the penalty exceeds extra fidelity + format + the full peer span (27). The curve keeps growing through the hard maximum (−464 at 200 MiB) and does not flatten. A bigger file loses to a smaller file of the same style and format.
7. Extra fidelity. Good +160 versus acceptable +40, a step of 120. That clears format + peer and loses to the size penalty from 60 MiB up.
8. Format preference (+48). Clears a normal peer. It does not clear a real size gap. `mp3_only` and `flac_only` stay hard filters and add no points. Inside `flac_only` the size curve still ranks the FLACs.
9. Peer availability, about 27 points (−16 to +11). Queues over 1000 are −60 and are not part of that span.
10. Username, then path.

| Component | Weight | What it measures |
| --- | --- | --- |
| `requestedVersion` | +12400 | The request names a version and this file matches it. The saved preference, including the second bonus, is 0 for every file on that request. A hybrid such as "Radio Edit - X Remix" does not outrank a pure radio edit on a radio-edit request. |
| `titleMatch` | +36 basename, +8 path only | Title tokens sit in the basename, or only in a folder. 0 when no title was passed. A wrong title is removed before this matters. |
| `artistInPath` | +48 | Artist tokens appear in the path. 0 when no artist was passed or the path lacks them. |
| `versionPreference` | +7800 basename, +5200 parent, +2600 clean original, +2600 second bonus, 0 for `balanced`, 0 when the request names a version | Saved style. The second bonus is a basename remix under `extended`, or a basename extended/club mix under `remix`. It ranks above radio edits and originals and below a parent-folder primary match. Each step clears the known-duration size penalty through the 200 MiB hard maximum, plus acceptable quality, fidelity, format, peer, and a mild duration overshoot. |
| `quality` | +160 good (256–320 kbps CBR, reported MP3 VBR at 220 or more, in-cap FLAC including hi-res); +40 acceptable (floor through 255, and MP3 VBR below 220); below the floor −(800 + round(64 × fraction^0.5)), so 128 kbps is −840 and 32 kbps is −864; 0 when unknown | The below-floor cliff is the acceptable-quality tier and outranks size. The +120 step from acceptable to good is extra fidelity and sits below size. A known rate under 128 kbps loses the version bonus. Hi-res inside the caps gets no extra. VBR on ogg does not enter the good tier. |
| `format` | +48 for `prefer_mp3` or `prefer_flac`, 0 for `auto` and the `_only` modes | Last among the preferences. Clears a normal peer. A 42 MiB FLAC does not beat a 14 MiB MP3 of the same version under `prefer_flac`. |
| `sizeOvershoot` | Known normal duration, as a ratio of the preferred 30 MiB: 0 up to 30, −96 at 45 (1.5×), −240 at 60 (2×), −464 at the 200 MiB hard maximum. Unknown duration or a long/overshooting file: 400 per 1.0 of (size/preferred − 1), uncapped | Thresholds are multiples of `preferred_max_file_size_mb`. From 60 MiB the penalty beats fidelity + format + peer. The curve keeps growing, so a 71 MiB file beats a 224 MiB file of the same style even on a slower peer when the hard cap is raised. The steep curve is part of the bad-result tier. |
| `durationOvershoot` | −400 × overRatio × (1 + overRatio), capped at −400. A 13 min file against 720 s keeps its version bonus. A 15 min file is −125 and still keeps it. The bonus stops when the penalty reaches −400 | A 13-minute extended mix under the 20-minute hard cap is still an extended mix. That cutoff is the duration cap, not the long-recording phrase penalty. |
| `longRecording` | −1900 | Basename or the immediate parent matches a long-recording phrase. No version bonus. A Remix DJ Set does not win on a remix preference. A normal-length Club Mix is not a long recording. |
| `shortRecording` | Scales from 0 at the short line to −1900 at 0 seconds | Known duration only. The line is 90 seconds, or 0.6 of the median known length when at least 5 lengths are known. Any hit removes the version bonus. An explicit requested version still applies. |
| `stem` | −22000 | Instrument-part basename, or stem / stems / multitrack / acapella, when the request did not ask for that part. No version bonus. Larger than the request plus every other positive component. |
| `availability` | +6 free slot, −4 no slot, −1 per 25 queued up to −12, −60 when the queue is over 1000, up to +5 for upload speed | Normal span 27. The −60 abandoned-peer penalty is outside that span. |

A stem penalty is larger than the requested-version bonus plus every positive component, so an incidental stem stays last. If the request itself names that stem or acapella term, the stem penalty is not applied and the requested version wins. A stem file alone is still eligible. It is not a hard filter.

Version terms are read from the basename first. The immediate parent folder is the primary match at +5200 when the basename does not match. Clean original (+2600) and the fun-style second bonus (+2600) are the same height and apply under different preferences, so they do not compete. There is no exception that lets quality, format, size, or peer flip a version step inside the default hard maximum. If the request names a version, none of these saved bonuses apply.

| Kind | Basename phrases |
| --- | --- |
| `radio_edit` | radio edit, radio version, radio mix, single edit, single version |
| `original` | original mix, original version, original, album version. A clean title with no version term counts as original at +2600, and only when the parent is clean too. |
| `extended` | extended, extended mix, extended version, club mix, 12" version, 12 inch |
| `remix` | remix, rmx, `<name> remix`, `<name> version`, `<name> edit`, where the name is not radio, single, album, original, or extended |

A bare `mix` is not a remix. `extended mix` and `club mix` are extended, and a normal-length Club Mix is not a long recording. Under `extended`, a named remix scores the +2600 second bonus. Under `remix`, an extended or club mix scores that same second bonus. The bonus is not applied to a long recording, a short fragment, a stem, a known bitrate under 128 kbps, or a duration overshoot that has reached −400. A mild overshoot, such as 13 minutes, keeps it. `balanced` adds no version bonus. A request that names a version adds none of these bonuses either. If the preferred version is missing, the best remaining file wins. A 70 MiB Club Mix wins under `extended` only when no normal-size club or extended file is in the set.

### Defaults

| Setting | Default | Role |
| --- | --- | --- |
| `min_file_size_mb` | 1 MiB | Hard floor. Null disables it. |
| `preferred_max_file_size_mb` | 30 MiB | Normal target for one song. Size penalty is 0 up to this, then graded. Env `SLSKD_PREFERRED_MAX_FILE_SIZE_MB`. |
| `max_file_size_mb` | 200 MiB | Hard exclusion. |
| `preferred_max_duration_seconds` | 720 | Penalty above 12 min. |
| `max_duration_seconds` | 1200 | Hard exclusion above 20 min. Null disables it. |
| `version_preference` | `extended` | Owner-chosen default. Club and extended mixes outrank radio edits. Env `SLSKD_VERSION_PREFERENCE`. |
| `format_preference` | `prefer_mp3` | Owner-chosen default. `auto` adds nothing. `prefer_flac` bonuses FLAC. `mp3_only` and `flac_only` filter. Env `SLSKD_FORMAT_PREFERENCE`. |
| `bitrate_floor_kbps` | 192 | Lossy rates below this are penalized. |
| `short_recording_fraction` | 0.6 | Known duration below this fraction of the search median is short. |
| `short_recording_min_samples` | 5 | Median fraction applies only with at least this many known lengths. |
| `short_recording_floor_seconds` | 90 | Known duration below this is short even without a median. |
| `short_recording_penalty` | −1900 | Most negative `shortRecording` score. |
| `max_sample_rate` | 48000 | Hard cap. Null disables it. |
| `max_bit_depth` | 24 | Hard cap. Null disables it. |

### Format balance

The normal target for one song is 30 MiB. A 320 kbps MP3 of a 6-minute song is about 14 MiB and pays nothing. A 16/44.1 FLAC of the same song is about 42 MiB and pays −77, which is already more than the format bonus (+48) and a normal peer swing, so `prefer_flac` does not take it over the MP3. At 60 MiB the penalty is −240, which also beats the good-versus-acceptable step (+120). At 69.9 MiB it is −256. At the 200 MiB hard maximum it is −464, and the curve is still rising: a 224 MiB file is −502.

A 35–45 MiB file of the preferred version still beats a 10 MiB radio edit. The gentle penalty at 45 MiB is −96, far under a version step. A 70 MiB Club Mix FLAC beats a normal-size Radio Edit only when no normal-size Club Mix or Extended file is available.

`flac_only` is still a hard filter. Among the FLACs that remain, the smaller one wins. A 71 MiB Club Mix on a slow peer beats a 224 MiB Club Mix on a free fast peer when the hard cap is raised. A file under 30 MiB and a file of about the same size are where format and peer still decide. A 128 kbps file does not beat a normal FLAC: the below-floor penalty outranks that size gap.

### Metadata the selector will use

From a live slskd 0.26 search for "Daft Punk Get Lucky" (251 responses, 583 files, 483 audio, 33 locked). The selector does not invent a field that was missing.

| Field | What was actually there |
| --- | --- |
| `size` | Present on all 583 files and always positive. The only universal field. |
| `length` | Duration in seconds. On 469 of 483 audio files (97%). Missing on all `.opus` and a few mp3/flac. Range 105–635 s, median 369. 28 tracks run 8–12 min. None are 12 min or longer. |
| `bitRate` | Only on lossy files (mp3/m4a/ogg), 282 files. Never on FLAC or WAV. Usually 128/192/320. Junk outliers include 8 and 2991. `isVariableBitRate` is set on 67. A reported VBR MP3 at about 220 kbps or more scores as good quality. The same flag on ogg or another format does not. CBR still needs 256–320 for that tier. Values of 321 or more, and anything outside 32–500 kbps, are unknown. |
| `sampleRate` / `bitDepth` | Only on lossless, 189 files (185 of 190 FLAC, plus WAV). bitDepth is 16 on 107 and 24 on 82. sampleRate is 44.1 kHz on 117, 88.2 kHz on 55, and 96 or 192 kHz on 15. |
| `extension` | Empty on 75%. One leading dot. One junk value (`flac@synoeastream`). The type comes from the filename when the field is empty or junk. Audio by filename: 265 mp3, 190 flac, 16 m4a, 6 ogg, 4 wav, 2 opus, plus video, lyrics, and images. |
| `filename` | Always Windows `\` paths, 1–8 folders deep. 346 start with a share alias like `@@abcde\`. Folder names often hold the only album, artist, or quality text. |
| Peer | All 251 responses. `hasFreeUploadSlot` true on 223. `queueLength` median 0, p90 93, max 44239. `uploadSpeed` median about 1.6 MB/s, and 0 on 7. |
| Audio size | p10 5.7 MiB, median 14.2, p75 41.8, p90 127, max 442. mp3 median 10.5 (max 24). FLAC median 42. |

Long-recording phrases match the basename, and the immediate parent folder. They do not walk deeper folders, and they never match `CD1`, `CD 1`, or `Disc 1`. A bare `mix` does not match, so "Extended Mix" and "Club Mix" are normal tracks. "Mixshow" does match. The default phrase list is `dj set`, `live at`, `live from`, `full album`, `full set`, `podcast`, `radio show`, `radioshow`, `mixshow`, `continuous mix`, `mixed by`, `megamix`, `essential mix`, `concert`, `episode`, and `ep.` plus a number. It is `acquisition.selection.long_recording_phrases`.

When duration is known and at or under 720 s, and the path is not a long-recording phrase, that is a normal length. When duration is missing, a normal length means no long-recording phrase and a size at or under the preferred max. The version-preference bonus is applied only then.

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
