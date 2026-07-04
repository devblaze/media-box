# Library (Movies, Series, Discovery)

REST reference for the media-box library endpoints. All routes live under `app/api/v1/**/route.ts`.

**Auth model.** Every `/api/v1` request must carry a valid session cookie **or** an `x-api-key: <apiKey>` header (an API key is treated as **admin**). Individual handlers may add a stronger guard:

- **admin** — `requireAdmin` (or an inline `getRequestUser` role check). Denied with `401` when unauthenticated, `403` when not an admin.
- **any authenticated** — no in-handler guard beyond the edge auth; any signed-in user or API key works. A few routes (`/credits`, `/discover`, `/discover/logo`) additionally re-check `getRequestUser` and return `401` if not signed in.

**Response helpers.** `ok` → `200` (or the passed status), `badRequest` → `400 {error}`, `notFound` → `404 {error}`, `serverError` → `400 {error, issues}` for Zod validation, **`409 {error}` when a file operation is blocked by read-only mode** (`MediaWritesDisabledError`), otherwise `500 {error}`.

**Read-only file operations.** When the admin turns **"Allow file operations" OFF** (Settings → Media Management), any delete that also removes files from disk (`?deleteFiles=true` / `?deleteFile=true`) is refused **before** the DB is touched and returns `409`. Deleting DB rows only (flag omitted/false) still works.

Set `MEDIABOX_URL` and `MEDIABOX_API_KEY` for the examples below.

---

## `GET /api/v1/movies`

List all movies (summary fields), sorted by sort title.

- **Auth:** any authenticated
- **Response:** `200` — array of `{ id, tmdbId, title, sortTitle, year, status, posterPath, path, monitored, qualityProfileId, movieFileId }`. Errors: `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/movies" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `POST /api/v1/movies`

Add a movie to the library by TMDB id, then enqueue a `DiskScan` for it.

- **Auth:** any authenticated
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `tmdbId` | integer > 0 | yes | — | TMDB movie id |
  | `rootFolderId` | integer > 0 | yes | — | must exist |
  | `qualityProfileId` | integer > 0 | yes | — | |
  | `monitored` | boolean | no | `true` | default applied in service |
  | `minimumAvailability` | `"announced"` \| `"inCinemas"` \| `"released"` | no | `"released"` | |

- **Response:** `201` — the created movie row (full record). Errors: `400` (validation); `500` if the movie is already in the library or the root folder is not found.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/movies" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"tmdbId":27205,"rootFolderId":1,"qualityProfileId":1}'
  ```

## `GET /api/v1/movies/{id}`

Fetch one movie plus its primary movie file.

- **Auth:** any authenticated
- **Path params:** `id` — movie id.
- **Response:** `200` — `{ ...movie, file }` where `file` is the primary `movieFiles` row or `null`. Errors: `404` (not found); `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/movies/12" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `PUT /api/v1/movies/{id}`

Update mutable movie settings.

- **Auth:** any authenticated
- **Path params:** `id` — movie id.
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `monitored` | boolean | no | — | |
  | `qualityProfileId` | integer > 0 | no | — | |
  | `minimumAvailability` | `"announced"` \| `"inCinemas"` \| `"released"` | no | — | |

- **Response:** `200` — the updated movie row. Errors: `404` (not found); `400` (validation); `500`.
- **Example:**
  ```bash
  curl -sS -X PUT "$MEDIABOX_URL/api/v1/movies/12" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H "Content-Type: application/json" -d '{"monitored":false}'
  ```

## `DELETE /api/v1/movies/{id}`

Remove a movie from the library, optionally deleting its files from disk.

- **Auth:** any authenticated
- **Path params:** `id` — movie id.
- **Query params:** `deleteFiles` — `true` also removes the movie folder from disk (default: DB row only).
- **Response:** `200` — `{ deleted: true }`. Errors: `400` (invalid id); **`409` if `deleteFiles=true` while file operations are disabled**; `500`.
- **Example:**
  ```bash
  curl -sS -X DELETE "$MEDIABOX_URL/api/v1/movies/12?deleteFiles=true" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `DELETE /api/v1/movies/{id}/versions/{fileId}`

Delete one quality version (a single `movieFiles` row) of a movie. If it was the primary, the largest remaining version becomes primary.

- **Auth:** admin
- **Path params:** `id` — movie id; `fileId` — movie file id.
- **Query params:** `deleteFile` — `true` also removes that file from disk (default: DB row only).
- **Response:** `200` — `{ deleted: boolean }` (`false` if the movie or file was not found). Errors: `400` (invalid id); `401`/`403` (auth); **`409` if `deleteFile=true` while file operations are disabled**; `500`.
- **Example:**
  ```bash
  curl -sS -X DELETE "$MEDIABOX_URL/api/v1/movies/12/versions/5?deleteFile=true" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/series`

List all series (summary fields with episode counts), sorted by sort title.

- **Auth:** any authenticated
- **Response:** `200` — array of `{ id, tmdbId, title, sortTitle, year, status, network, posterPath, path, monitored, monitorMode, isAnime, qualityProfileId, episodeCount, episodeFileCount }` (counts exclude specials, season 0). Errors: `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/series" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `POST /api/v1/series`

Add a series to the library by TMDB id, then enqueue a `DiskScan` for it.

- **Auth:** any authenticated
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `tmdbId` | integer > 0 | yes | — | TMDB series id |
  | `rootFolderId` | integer > 0 | yes | — | |
  | `qualityProfileId` | integer > 0 | yes | — | |
  | `monitored` | boolean | no | — | |
  | `monitorMode` | `"all"` \| `"future"` \| `"none"` | no | — | which episodes to monitor |
  | `seasonFolder` | boolean | no | — | |

- **Response:** `201` — the created series row. Errors: `400` (validation); `500`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/series" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"tmdbId":1396,"rootFolderId":2,"qualityProfileId":1,"monitorMode":"all"}'
  ```

## `GET /api/v1/series/{id}`

Fetch one series with its seasons, episodes, and episode files.

- **Auth:** any authenticated
- **Path params:** `id` — series id.
- **Response:** `200` — `{ ...series, seasons: [...], episodes: [...], files: [...] }`. Errors: `404` (not found); `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/series/3" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `PUT /api/v1/series/{id}`

Update series settings and/or per-season / per-episode monitored flags. Setting `monitorMode` re-derives every season/episode monitored flag.

- **Auth:** any authenticated
- **Path params:** `id` — series id.
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `monitored` | boolean | no | — | |
  | `monitorMode` | `"all"` \| `"future"` \| `"none"` | no | — | re-derives season/episode flags |
  | `qualityProfileId` | integer > 0 | no | — | |
  | `seasonFolder` | boolean | no | — | |
  | `seasons` | array of `{ seasonNumber: int, monitored: bool }` | no | — | sets each season + its episodes |
  | `episodes` | array of `{ id: int, monitored: bool }` | no | — | per-episode override |

- **Response:** `200` — the updated series row. Errors: `404` (not found); `400` (validation); `500`.
- **Example:**
  ```bash
  curl -sS -X PUT "$MEDIABOX_URL/api/v1/series/3" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"seasons":[{"seasonNumber":1,"monitored":false}]}'
  ```

## `DELETE /api/v1/series/{id}`

Remove a series from the library, optionally deleting its files from disk.

- **Auth:** any authenticated
- **Path params:** `id` — series id.
- **Query params:** `deleteFiles` — `true` also removes files from disk (default: DB rows only).
- **Response:** `200` — `{ deleted: true }`. Errors: `400` (invalid id); **`409` if `deleteFiles=true` while file operations are disabled**; `500`.
- **Example:**
  ```bash
  curl -sS -X DELETE "$MEDIABOX_URL/api/v1/series/3?deleteFiles=true" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/episodes/{id}/neighbors`

Previous / next **playable** episode (one that has a file) relative to this episode, ordered across season boundaries. Feeds the player's Prev/Next + auto-advance.

- **Auth:** any authenticated
- **Path params:** `id` — episode id.
- **Response:** `200` — `{ prev, next }` where each is `{ id, seasonNumber, episodeNumber, title, seriesTitle }` or `null`. Errors: `400` (invalid id); `404` (episode not found); `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/episodes/842/neighbors" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/wanted`

Missing but wanted media: monitored episodes that have aired without a file, and monitored movies without a file.

- **Auth:** any authenticated
- **Response:** `200` — `{ episodes, movies }`. `episodes[]`: `{ episodeId, seriesId, seriesTitle, seasonNumber, episodeNumber, episodeTitle, airDateUtc }` (aired before now, newest first, max 200). `movies[]`: `{ movieId, title, year, status, minimumAvailability }` (newest added first, max 200). Errors: `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/wanted" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/rootfolders`

List configured root folders with accessibility and free space.

- **Auth:** admin
- **Response:** `200` — array of root folder rows, each with `accessible` (boolean, write-check) and `freeSpace` (bytes, or `null` if inaccessible). Errors: `401`/`403` (auth); `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/rootfolders" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `POST /api/v1/rootfolders`

Create a root folder (creates the directory on disk if missing).

- **Auth:** admin
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `path` | string (min 1) | yes | — | absolute path; created if absent |
  | `mediaType` | `"series"` \| `"movies"` \| `"anime"` | yes | — | |

- **Response:** `201` — the created root folder row. Errors: `400` (validation); `401`/`403` (auth); `500`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/rootfolders" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H "Content-Type: application/json" -d '{"path":"/media/movies","mediaType":"movies"}'
  ```

## `DELETE /api/v1/rootfolders/{id}`

Delete a root folder (only if no library item references it).

- **Auth:** admin
- **Path params:** `id` — root folder id.
- **Response:** `200` — `{ deleted: true }`. Errors: `400` (invalid id, or `"Root folder is in use by library items"`); `401`/`403` (auth); `500`.
- **Example:**
  ```bash
  curl -sS -X DELETE "$MEDIABOX_URL/api/v1/rootfolders/1" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/naming`

Read the naming configuration (single row).

- **Auth:** admin
- **Response:** `200` — the naming config row. Errors: `401`/`403` (auth); `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/naming" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `PUT /api/v1/naming`

Update the naming configuration (row id 1).

- **Auth:** admin
- **Request body:** (all optional; string formats must be non-empty)

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | `renameEpisodes` | boolean | no | — | |
  | `replaceIllegalCharacters` | boolean | no | — | |
  | `standardEpisodeFormat` | string (min 1) | no | — | |
  | `seriesFolderFormat` | string (min 1) | no | — | |
  | `seasonFolderFormat` | string (min 1) | no | — | |
  | `movieFormat` | string (min 1) | no | — | |
  | `movieFolderFormat` | string (min 1) | no | — | |

- **Response:** `200` — the updated naming config row. Errors: `400` (validation); `401`/`403` (auth); `500`.
- **Example:**
  ```bash
  curl -sS -X PUT "$MEDIABOX_URL/api/v1/naming" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H "Content-Type: application/json" -d '{"renameEpisodes":true}'
  ```

## `GET /api/v1/lookup`

TMDB search for the request flow, annotated with library availability. Anime is searched as TV.

- **Auth:** any authenticated
- **Query params:**

  | param | type | required | notes |
  | --- | --- | --- | --- |
  | `q` | string | yes | search term (trimmed) |
  | `type` | `"series"` \| `"movie"` \| `"anime"` | yes | |

- **Response:** `200` — array of `{ tmdbId, title, year, overview, poster, posterPath, status, mediaId }`. `status` is the availability (`"unavailable"` when not in library). Errors: `400` (missing `q` or bad `type`); `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/lookup?type=movie&q=inception" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/credits`

Cast for a title (plain cast for movies; aggregate incl. voice actors for series/anime), capped at 30.

- **Auth:** any authenticated (returns `401 {error:"Not signed in"}` if not)
- **Query params:**

  | param | type | required | notes |
  | --- | --- | --- | --- |
  | `type` | `"movie"` \| `"series"` | yes | |
  | `tmdbId` | integer > 0 | yes | |

- **Response:** `200` — `{ cast: [{ id, name, character, profile }] }`. Errors: `400` (bad `type`/`tmdbId`); `401` (not signed in); `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/credits?type=movie&tmdbId=27205" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/discover`

Browse/search titles from TMDB (and recently-added library items), annotated with library availability. Powers the discovery UI rows.

- **Auth:** any authenticated (returns `401 {error:"Not signed in"}` if not)
- **Query params:**

  | param | type | required | notes |
  | --- | --- | --- | --- |
  | `category` | string | no | default `"trending"`. See below. |
  | `q` | string | only when `category=search` | search term |

  Categories: `trending` (default, mixed), `recently-added`, `search`, `popular-movies`/`movies-popular`, `movies-trending`, `movies-top`, `popular-series`/`series-popular`, `series-trending`, `series-top`, `anime-popular`, `anime-new`, `anime-top`, `anime-movies`. `series-*` feeds exclude anime; `anime-*` feeds include only anime.

- **Response:** `200` — array of `DiscoverItem`: `{ tmdbId, mediaType, title, year, poster, posterPath, backdrop, isAnime, overview, status, mediaId }`. Errors: `400` (missing `q` for search); `401` (not signed in); `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/discover?category=movies-trending" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/discover/recommendations`

"Because you watched X" rows for the signed-in user: for each of their most recent watched titles, TMDB's recommendations for it (annotated with library availability). Powers the Discover page rows that adapt to viewing history.

- **Auth:** any authenticated (returns `401 {error:"Not signed in"}` if not)
- **Query params:** none.
- **Response:** `200` — array of groups `{ basedOn: { tmdbId, mediaType, title }, items: DiscoverItem[] }`. Empty when there's no watch history yet. Errors: `401`; `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/discover/recommendations" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/discover/logo`

Best title-logo artwork (transparent PNG) for a TMDB title, used by the hero billboard.

- **Auth:** any authenticated (returns `401 {error:"Not signed in"}` if not)
- **Query params:**

  | param | type | required | notes |
  | --- | --- | --- | --- |
  | `type` | `"movie"` \| `"series"` | yes | |
  | `tmdbId` | integer > 0 | yes | |

- **Response:** `200` — `{ logo }` (a URL or `null`). Errors: `400` (bad `type`/`tmdbId`); `401` (not signed in); `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/discover/logo?type=series&tmdbId=1396" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

## `GET /api/v1/calendar`

Upcoming (and recent) air dates for episodes of monitored series/anime — the schedule calendar.

- **Auth:** any authenticated
- **Query params:**

  | param | type | required | notes |
  | --- | --- | --- | --- |
  | `start` | ISO date string | no | window start; default = today |
  | `end` | ISO date string | no | window end; default = `start` + ~6 weeks (42 days) |

- **Response:** `200` — array of `{ episodeId, seriesId, seriesTitle, posterPath, isAnime, seasonNumber, episodeNumber, episodeTitle, airDateUtc, hasFile }`, sorted by air date. Errors: `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/calendar?start=2026-07-01&end=2026-07-31" -H "x-api-key: $MEDIABOX_API_KEY"
  ```
