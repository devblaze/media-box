# System, Settings & Import

Admin-facing endpoints for app-wide settings, quality profiles/definitions, system status & scheduled tasks, logs, the on-disk directory browser, the library-import wizard, the download organizer, and the Sonarr/Radarr/Bazarr migration wizard. Every request authenticates via the `session` cookie or an `x-api-key: <apiKey>` header (treated as a synthetic admin — id `0`, username `api`); `/health` is the only public endpoint. Success bodies come from `ok(...)` (200 unless noted); errors use `badRequest` (400), `notFound` (404), `serverError` (500, or 400 on a Zod `"Validation failed"` with an `issues` array, or 409 on `MediaWritesDisabledError` — a write blocked because `fileOperationsEnabled` is off).

## `GET /api/v1/settings`

Read the full app-wide settings object (admin). Secrets (API keys, passwords, tokens) are returned in the clear.

- **Auth:** admin
- **Response:** `200` — the full settings object (every field from the table under `PUT`, plus `apiKey` and `kioskToken`). `apiKey` is auto-generated on first read if empty. Errors: `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/settings" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `PUT /api/v1/settings`

Update app-wide settings (admin). Only the fields below are accepted; unknown keys are ignored. Note the read-side `appSettingsSchema` also holds `apiKey` and `kioskToken`, but neither is settable through this route.

- **Auth:** admin
- **Request body:** all fields optional; send only what you change. Values marked "coerced" accept string forms (e.g. `"true"`, `"3"`).

  | field | type | default | notes |
  | --- | --- | --- | --- |
  | `fileOperationsEnabled` | boolean (coerced) | `true` | **Master read-only switch.** When `false`, media-box never moves, renames, or deletes files: imports and organizing are refused, replaced-file and library-delete cleanups are refused, and downloads simply wait to be imported until it is turned back on. Blocked writes return `409`. |
  | `tmdbApiKey` | string | `""` | TMDB v3 API key used for metadata lookups. |
  | `logLevel` | enum `debug` \| `info` \| `warn` \| `error` | `info` | Minimum level persisted to the log. |
  | `urlBase` | string | `""` | Reverse-proxy path prefix (e.g. `/mediabox`). |
  | `downloadsPath` | string | `""` | Completed-downloads folder the organizer scans. Seeded from env on first boot. |
  | `moviesPath` | string | `""` | Movies library share. |
  | `seriesPath` | string | `""` | Series library share. |
  | `animePath` | string | `""` | Anime library share. |
  | `importMode` | enum `auto` \| `hardlink` \| `copy` \| `move` | `auto` | How imports place files into the library. |
  | `transcodeHwAccel` | enum `none` \| `vaapi` \| `qsv` \| `nvenc` | `none` | HLS transcoding hardware-accel path. |
  | `transcodeVaapiDevice` | string | `/dev/dri/renderD128` | VAAPI/QSV render device node. |
  | `maxTranscodeSessions` | number (coerced int, 1–10) | `3` | Concurrent transcode session cap. |
  | `maxBacklogGrabsPerRun` | number (coerced int, 0–50) | `3` | Max releases the 24h backlog search grabs per run (`0` = unlimited). |
  | `subtitleLanguages` | string | `""` | Wanted subtitle languages — comma-separated ISO 639-1 codes (e.g. `"en,es"`). |
  | `subtitleProvider` | enum `none` \| `opensubtitles` | `none` | Legacy single-provider selector (superseded by `subtitleProviders`). |
  | `subtitleProviders` | string | `""` | Enabled providers as a comma-separated id list in priority order (e.g. `"opensubtitles,podnapisi"`). Empty = subtitles off. |
  | `subtitleHearingImpaired` | boolean (coerced) | `false` | Prefer hearing-impaired (SDH) subtitles. |
  | `openSubtitlesApiKey` | string | `""` | OpenSubtitles.com API key. |
  | `openSubtitlesUsername` | string | `""` | OpenSubtitles account username. |
  | `openSubtitlesPassword` | string | `""` | OpenSubtitles account password. |
  | `pushoverAppToken` | string | `""` | Pushover Application API token — enables per-user request notifications. |
  | `requestsAutoApprove` | boolean (coerced) | `false` | When `true`, user requests are added immediately (no admin approval); when `false` they land as `pending`. |

  Not settable here (read-only via GET): `apiKey`, `kioskToken`, and the remembered migration credentials `sonarrUrl` / `sonarrApiKey` / `radarrUrl` / `radarrApiKey` / `bazarrUrl` / `bazarrApiKey` (those are written by the migration routes).

- **Response:** `200` — the full, updated settings object. Errors: `400` on a bad body.
- **Example:**
  ```bash
  curl -sS -X PUT "$MEDIABOX_URL/api/v1/settings" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H 'content-type: application/json' -d '{"fileOperationsEnabled": false}'
  ```

## `POST /api/v1/settings/tmdb-test`

Validate a TMDB API key with a live `GET /3/configuration` call.

- **Auth:** admin
- **Request body:**

  | field | type | required | notes |
  | --- | --- | --- | --- |
  | `tmdbApiKey` | string | yes | min length 1. |

- **Response:** `200` — `{ "ok": true }` if the key works, else `{ "ok": false, "message": "TMDB responded <status>" }`. Errors: `400` on a bad body.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/settings/tmdb-test" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H 'content-type: application/json' -d '{"tmdbApiKey":"abc123"}'
  ```

## `POST /api/v1/settings/transcode-test`

Run a short synthetic ffmpeg encode with the chosen hardware-accel path to verify GPU transcoding works (`runtime = "nodejs"`).

- **Auth:** admin
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `transcodeHwAccel` | enum `none` \| `vaapi` \| `qsv` \| `nvenc` | yes | — | Accel path to probe. |
  | `transcodeVaapiDevice` | string | no | `/dev/dri/renderD128` | Render device node for vaapi/qsv. |

- **Response:** `200` — `{ ok: boolean, ffmpegAvailable: boolean, mode: string, label: string, message: string }`. `ok:false, ffmpegAvailable:false` when ffmpeg is not installed. Errors: `400` on a bad body.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/settings/transcode-test" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H 'content-type: application/json' -d '{"transcodeHwAccel":"vaapi"}'
  ```

## `GET /api/v1/qualityprofiles`

List all quality profiles, ordered by id.

- **Auth:** admin
- **Response:** `200` — array of quality-profile rows. Errors: `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/qualityprofiles" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `POST /api/v1/qualityprofiles`

Create a quality profile.

- **Auth:** admin
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `name` | string | yes | — | min length 1. |
  | `cutoffQualityId` | number (int) | yes | — | Must be one of the `allowed` items (else `400`). |
  | `items` | array of `{ qualityId: int, allowed: boolean }` | yes | — | min 1 entry. |
  | `upgradeAllowed` | boolean | no | `true` | Allow upgrades until cutoff is met. |
  | `preferredTerms` | array of `{ term: string, score: int }` | no | `[]` | Scored release-title preferences. |
  | `requiredTerms` | array of string | no | `[]` | Release title must contain all. |
  | `ignoredTerms` | array of string | no | `[]` | Release title must contain none. |

- **Response:** `201` — the created profile row. Errors: `400` — `"Cutoff must be one of the allowed qualities"` or a Zod validation error.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/qualityprofiles" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H 'content-type: application/json' \
    -d '{"name":"HD","cutoffQualityId":7,"items":[{"qualityId":7,"allowed":true}]}'
  ```

## `PUT /api/v1/qualityprofiles/[id]`

Replace a quality profile by id.

- **Auth:** admin
- **Path params:** `id` — profile id.
- **Request body:** same fields as `POST`, except `upgradeAllowed` is **required** here (no default). Cutoff must still be one of the allowed items.
- **Response:** `200` — the updated profile row. Errors: `404` — `"Profile not found"`; `400` — `"Cutoff must be one of the allowed qualities"` or a Zod validation error.
- **Example:**
  ```bash
  curl -sS -X PUT "$MEDIABOX_URL/api/v1/qualityprofiles/3" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H 'content-type: application/json' \
    -d '{"name":"HD","upgradeAllowed":true,"cutoffQualityId":7,"items":[{"qualityId":7,"allowed":true}]}'
  ```

## `DELETE /api/v1/qualityprofiles/[id]`

Delete a quality profile by id.

- **Auth:** admin
- **Path params:** `id` — profile id.
- **Response:** `200` — `{ "deleted": true }`. Errors: `400` — `"Invalid id"` (non-integer) or `"Profile is in use by library items"` (any series/movie still references it).
- **Example:**
  ```bash
  curl -sS -X DELETE "$MEDIABOX_URL/api/v1/qualityprofiles/3" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `POST /api/v1/qualityprofiles/dedupe`

Merge duplicate profiles that share a name (case-insensitive). Per name group, the lowest-id row is canonical; series/movies pointing at duplicates are reassigned to it, then duplicates are deleted. Idempotent.

- **Auth:** admin
- **Response:** `200` — `{ "merged": number, "reassignedSeries": number, "reassignedMovies": number }`. Errors: `500`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/qualityprofiles/dedupe" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/qualitydefinitions`

List the built-in quality definitions (the fixed `QUALITIES` set), sorted by ascending rank. These are the `qualityId` values referenced by profiles.

- **Auth:** admin
- **Response:** `200` — array of quality definitions sorted by `rank`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/qualitydefinitions" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/system/status`

Basic app/runtime status. No auth guard — returns static process info only.

- **Auth:** none (unguarded)
- **Response:** `200` — `{ appName: "media-box", version: string, startedAt: ISO string, configDir: string, node: string }`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/system/status"
  ```

## `GET /api/v1/system/events`

Server-Sent Events stream (`text/event-stream`). Emits `data: <json>` frames from the app event bus (the UI invalidates SWR caches on receipt), an initial `retry: 5000`, and a `: keep-alive` comment every 25s. Closes on request abort. No auth guard on the handler.

- **Auth:** none (unguarded)
- **Response:** `200` — an event stream; headers `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`.
- **Example:**
  ```bash
  curl -sS -N "$MEDIABOX_URL/api/v1/system/events"
  ```

## `GET /api/v1/system/tasks`

List all scheduled tasks, ordered by name.

- **Auth:** admin
- **Response:** `200` — array of scheduled-task rows. Errors: `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/system/tasks" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `PUT /api/v1/system/tasks/[name]`

Update a scheduled task's schedule / enabled state and recompute its next run (`runtime = "nodejs"`).

- **Auth:** admin
- **Path params:** `name` — task name.
- **Request body:** all optional.

  | field | type | notes |
  | --- | --- | --- |
  | `scheduleKind` | enum `interval` \| `daily` \| `weekly` | Scheduling mode. |
  | `intervalMinutes` | number (coerced int, 1–43200) | Interval for `interval` kind. |
  | `scheduleHour` | number (coerced int, 0–23) \| null | Hour for daily/weekly. |
  | `scheduleMinute` | number (coerced int, 0–59) \| null | Minute for daily/weekly. |
  | `scheduleDay` | number (coerced int, 0–6) \| null | Day of week for weekly. |
  | `enabled` | boolean | Enable/disable the task. |

- **Response:** `200` — the updated task row (with recomputed `nextRunAt`). Errors: `404` — `"Task not found"`; `400` on a bad body.
- **Example:**
  ```bash
  curl -sS -X PUT "$MEDIABOX_URL/api/v1/system/tasks/RefreshMonitored" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H 'content-type: application/json' -d '{"enabled":false}'
  ```

## `GET /api/v1/system/tasks/[name]/runs`

Recent runs (command history) for a scheduled task — its logs/output. Newest first, up to 30 (`runtime = "nodejs"`).

- **Auth:** admin
- **Path params:** `name` — task name.
- **Response:** `200` — array of up to 30 rows `{ id, status, trigger, queuedAt, startedAt, endedAt, result, error }`. Errors: `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/system/tasks/RefreshMonitored/runs" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/logs`

Read the persisted application log, newest first (`runtime = "nodejs"`).

- **Auth:** admin
- **Query params:**

  | param | type | default | notes |
  | --- | --- | --- | --- |
  | `level` | `debug` \| `info` \| `warn` \| `error` | (none) | Exact-level filter; invalid/absent = no filter. |
  | `limit` | int | `200` | Clamped to 1–1000. |

- **Response:** `200` — array of log-entry rows. Errors: `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/logs?level=error&limit=50" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `DELETE /api/v1/logs`

Clear all log entries.

- **Auth:** admin
- **Response:** `200` — `{ "cleared": true }`. Errors: `500`.
- **Example:**
  ```bash
  curl -sS -X DELETE "$MEDIABOX_URL/api/v1/logs" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/versions`

Available quality versions (files) for a movie or episode — powers the player's version picker (`runtime = "nodejs"`). Any signed-in user.

- **Auth:** user (any authenticated user; unauthenticated → `401 "Not signed in"`)
- **Query params:**

  | param | type | required | notes |
  | --- | --- | --- | --- |
  | `type` | `movie` \| `episode` | yes | Else `400`. |
  | `id` | int > 0 | yes | Movie or episode id; else `400`. |

- **Response:** `200` — `{ "versions": [...] }`. Errors: `400` on bad `type`/`id`; `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/versions?type=movie&id=42" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/health`

Liveness probe — runs `SELECT 1` against the DB. Public, no auth.

- **Auth:** public
- **Response:** `200` — `{ "status": "healthy" }`. Errors: `500` if the DB query fails.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/health"
  ```

## `GET /api/v1/fs`

Server-side directory browser powering path pickers in the UI. Lists immediate subdirectories (hidden dot-dirs excluded), sorted by name.

- **Auth:** admin
- **Query params:**

  | param | type | default | notes |
  | --- | --- | --- | --- |
  | `path` | string | `/` | Directory to list (resolved server-side). |

- **Response:** `200` — `{ path: string (resolved), parent: string | null, directories: [{ name, path }] }`. Errors: `500` (e.g. path does not exist / not readable).
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/fs?path=/mnt/media" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `POST /api/v1/library-import`

Import an existing on-disk folder into the library at its current path (no move): creates the movie/series, then registers the files already there so it shows as available immediately (`runtime = "nodejs"`).

- **Auth:** admin
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `type` | enum `movie` \| `series` \| `anime` | yes | — | Media kind (`anime` = series with `isAnime`). |
  | `path` | string | yes | — | Folder to import (min length 1). |
  | `tmdbId` | int > 0 | yes | — | Matched TMDB id. |
  | `rootFolderId` | int > 0 | yes | — | Target root folder. |
  | `qualityProfileId` | int > 0 | yes | — | Quality profile to assign. |
  | `videoPath` | string | no | — | Absolute path of the specific movie file to register (movies only). |
  | `monitored` | boolean | no | `true` | Monitor after import. |

- **Response:** `201` — `{ id, mediaType, files }` on a fresh import (movie/series/anime). For a movie already in the library with a `videoPath`, `200` — `{ id, mediaType: "movie", version }` (registers an extra quality version). Errors: `400` — `"Invalid request body"`; `409` — `"Movie is already in the library"` (movie present, no `videoPath`) or when the underlying add reports the title is already present.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/library-import" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H 'content-type: application/json' \
    -d '{"type":"movie","path":"/movies/Dune (2021)","tmdbId":438631,"rootFolderId":1,"qualityProfileId":1}'
  ```

## `GET /api/v1/library-import/scan`

Scan a library root folder for on-disk titles not yet imported, matching each against TMDB; persists the scan so results survive navigation (`runtime = "nodejs"`).

- **Auth:** admin
- **Query params:**

  | param | type | required | notes |
  | --- | --- | --- | --- |
  | `type` | `movie` \| `series` \| `anime` | yes | Else `400`. |
  | `rootFolderId` | int | yes | Must exist (else `400 "Unknown root folder"`). |
  | `qualityProfileId` | int > 0 | no | Stored with the persisted scan; ignored if not a positive int. |

- **Response:** `200` — `{ root: string, candidates: [...], truncated: boolean }`. Errors: `400` — bad `type`, missing `rootFolderId`, or `"Unknown root folder"`; `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/library-import/scan?type=movie&rootFolderId=1" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/library-import/candidates`

Reload the not-yet-imported candidates from the last persisted scan of `type` (imported rows have already dropped off) (`runtime = "nodejs"`).

- **Auth:** admin
- **Query params:**

  | param | type | required | notes |
  | --- | --- | --- | --- |
  | `type` | `movie` \| `series` \| `anime` | yes | Else `400`. |

- **Response:** `200` — `{ "candidates": [...] }`. Errors: `400` on bad `type`; `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/library-import/candidates?type=series" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `POST /api/v1/library-import/import-all`

Kick off a background batch import of every confidently-matched, not-yet-imported candidate of `type`. Returns immediately; work runs as a scheduler command (`LibraryImportBatch`) tracked via `command.updated` events (`runtime = "nodejs"`).

- **Auth:** admin
- **Request body:**

  | field | type | required | notes |
  | --- | --- | --- | --- |
  | `type` | enum `movie` \| `series` \| `anime` | yes | Else `400`. |

- **Response:** `201` — `{ id: number, queued: true }` when newly queued; `200` — `{ id: null, queued: false }` when an identical command is already queued/running (de-duped). Errors: `400` on a bad body.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/library-import/import-all" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H 'content-type: application/json' -d '{"type":"movie"}'
  ```

## `POST /api/v1/library-import/reset`

Remove every library entry from the database (movies, series, and their files, plus watch progress, subtitle files, and any persisted scan). **DB-only** — files on disk are not touched and can be re-imported (`runtime = "nodejs"`).

- **Auth:** admin
- **Response:** `200` — per-table delete counts `{ watchProgress, subtitleFiles, episodeFiles, episodes, seasons, movieFiles, movies, series }`. Errors: `500`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/library-import/reset" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/organizer/scan`

Scan the configured downloads folder for loose video files, classify each, and match it to a library title (`runtime = "nodejs"`).

- **Auth:** admin
- **Response:** `200` — `{ root: string (downloadsPath), items: [...] }`. Errors: `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/organizer/scan" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `POST /api/v1/organizer/organize`

Organize a single loose file into the library at an explicit target: place file + register file row + link episode/movie + log (`runtime = "nodejs"`). Blocked (`409`) when `fileOperationsEnabled` is off.

- **Auth:** admin
- **Request body:**

  | field | type | required | notes |
  | --- | --- | --- | --- |
  | `sourcePath` | string | yes | Loose file to organize (min length 1). |
  | `kind` | enum `series` \| `anime` \| `movie` | yes | Target media kind. |
  | `id` | int > 0 | yes | Target library item id. |
  | `seasonNumber` | int ≥ 0 | no | Series/anime only. |
  | `episodeNumbers` | array of int > 0 | no | Series/anime only. |

- **Response:** `200` — the organize result `{ status: "organized", destPath, detail, ... }`. Errors: `400` — `"Invalid request body"`; `409` — `"already in the library"` / `"not in the library"` conflicts, or `MediaWritesDisabledError` when read-only mode is on; `500`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/organizer/organize" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H 'content-type: application/json' \
    -d '{"sourcePath":"/downloads/show.s01e02.mkv","kind":"series","id":5,"seasonNumber":1,"episodeNumbers":[2]}'
  ```

## `POST /api/v1/organizer/organize/bulk`

Organize many files in one request (e.g. a batch of episodes into a series). Each file is independent — a per-file failure/skip does not abort the rest (`runtime = "nodejs"`). Individual files are blocked when `fileOperationsEnabled` is off (surfaced per-file as failures).

- **Auth:** admin
- **Request body:**

  | field | type | required | notes |
  | --- | --- | --- | --- |
  | `items` | array of organize items | yes | 1–500 entries; each item has the same shape as the single-file `POST` body (`sourcePath`, `kind`, `id`, optional `seasonNumber`, `episodeNumbers`). |

- **Response:** `200` — `{ organized: number, failed: number, skipped: number, results: [{ sourcePath, status: "organized"|"failed"|"skipped", detail?, destPath?, error? }] }`. Already-/not-in-library conflicts count as `skipped`. Errors: `400` — `"Invalid request body"`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/organizer/organize/bulk" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H 'content-type: application/json' \
    -d '{"items":[{"sourcePath":"/downloads/s01e01.mkv","kind":"series","id":5,"seasonNumber":1,"episodeNumbers":[1]}]}'
  ```

## `GET /api/v1/organizer/log`

Newest-first organize log, filtered by text query, media type, and status (`runtime = "nodejs"`).

- **Auth:** admin
- **Query params:**

  | param | type | notes |
  | --- | --- | --- |
  | `q` | string | Free-text filter. |
  | `type` | `movie` \| `series` \| `anime` | Invalid/absent = no filter. |
  | `status` | `organized` \| `failed` \| `skipped` | Invalid/absent = no filter. |
  | `limit` | int > 0 | Row cap (omit for default). |

- **Response:** `200` — array of organize-log rows. Errors: `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/organizer/log?status=failed&limit=100" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `POST /api/v1/migrate/[app]`

Connect to a Sonarr/Radarr instance and return a migration **preview**. On success the connection URL + API key are remembered in settings (per app) for wizard prefill.

- **Auth:** admin
- **Path params:** `app` — `sonarr` or `radarr` (else `400 "Unknown app — use sonarr or radarr"`).
- **Request body:**

  | field | type | required | notes |
  | --- | --- | --- | --- |
  | `url` | string (URL) | yes | Base URL of the source app. |
  | `apiKey` | string | yes | Source app API key (min length 1). |

- **Response:** `200` — the migration preview object. Errors: `400` — unknown app or a Zod validation error; `500` — connection failure.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/migrate/sonarr" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H 'content-type: application/json' -d '{"url":"http://sonarr:8989","apiKey":"KEY"}'
  ```

## `PUT /api/v1/migrate/[app]`

Execute the migration — queued as a background scheduler command (`ExecuteMigration`).

- **Auth:** admin
- **Path params:** `app` — `sonarr` or `radarr` (else `400`).
- **Request body:**

  | field | type | required | notes |
  | --- | --- | --- | --- |
  | `conn` | `{ url: URL string, apiKey: string }` | yes | Source-app connection. |
  | `decisions.profileMap` | record<string, number \| `"create"`> | yes | Map source profile → target profile id (or create). |
  | `decisions.pathRewrites` | array of `{ from: string, to: string }` | yes | Path remaps. |
  | `decisions.importIndexers` | boolean | yes | Also import indexers. |
  | `decisions.importClients` | boolean | yes | Also import download clients. |
  | `decisions.rootFolderId` | int | yes | Default target root folder. |
  | `decisions.rootFolderMap` | record<string, int> | no | Per-source-path root-folder overrides. |

- **Response:** `202` — `{ commandId: number | null, queued: boolean }` (`null`/`false` when an identical command is already queued). Errors: `400` — unknown app or a Zod validation error.
- **Example:**
  ```bash
  curl -sS -X PUT "$MEDIABOX_URL/api/v1/migrate/sonarr" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H 'content-type: application/json' \
    -d '{"conn":{"url":"http://sonarr:8989","apiKey":"KEY"},"decisions":{"profileMap":{},"pathRewrites":[],"importIndexers":true,"importClients":true,"rootFolderId":1}}'
  ```

## `POST /api/v1/migrate/bazarr`

Connect to Bazarr and import its subtitle configuration (languages + provider) into settings. On success the Bazarr URL + API key are remembered for prefill (`runtime = "nodejs"`).

- **Auth:** admin
- **Request body:**

  | field | type | required | notes |
  | --- | --- | --- | --- |
  | `url` | string (URL) | yes | Bazarr base URL. |
  | `apiKey` | string | yes | Bazarr API key (min length 1). |

- **Response:** `200` — `{ languages, provider, imported: true, note }`. Errors: `400` on a bad body; `500` — connection failure.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/migrate/bazarr" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H 'content-type: application/json' -d '{"url":"http://bazarr:6767","apiKey":"KEY"}'
  ```
