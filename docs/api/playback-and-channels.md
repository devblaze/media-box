# Playback, Transcode, Subtitles & Channels

REST reference for the media-box endpoints that drive playback: direct file streaming (with HTTP Range/seek), on-the-fly HLS transcoding, subtitle discovery/download, per-user watch progress, and the Live TV channels.

**Auth.** Every request is authenticated by a session cookie **or** an `x-api-key: <apiKey>` header (an API key is treated as an admin). Guards used below:

- **Admin** — `requireAdmin` in the handler; a non-admin session gets `403`, an unauthenticated request `401`.
- **User** — any authenticated principal (`getRequestUser` presence); unauthenticated gets `401`.
- **Any authenticated (proxy-enforced)** — the handler performs no in-code check; only the presence of a session cookie / API key (enforced by the proxy) is required.

An API-key principal has no library user identity, so per-user write endpoints (`PUT /watch-progress`, `POST /watch-progress/watched`) short-circuit to a no-op `200` for it.

Standard JSON error envelope is `{ "error": "..." }` (Zod validation failures add `{ "error": "Validation failed", "issues": [...] }`). Status codes: `200` ok, `400` bad request, `401` unauthenticated, `403` forbidden, `404` not found, `409` writes-disabled conflict, `429` transcode cap reached, `503` ffmpeg missing, `500` server error.

Examples assume `MEDIABOX_URL` and `MEDIABOX_API_KEY` are set.

---

## `GET /api/v1/streams`

Who is streaming right now — powers the admin dashboard "Now streaming" card. Inferred from recent watch-progress heartbeats.

- **Auth:** Admin.
- **Response:** `200` — array of active streams:
  ```json
  [
    {
      "userId": 3,
      "username": "alice",
      "stream": {
        "kind": "movie",
        "title": "Inception",
        "subtitle": "2010",
        "poster": "https://…",
        "progressPct": 42,
        "positionSeconds": 3120,
        "durationSeconds": 8880,
        "updatedAt": 1751630400000
      }
    }
  ]
  ```
  Errors: `401`, `403`, `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/streams" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `GET` / `HEAD /api/v1/stream/movie/[id]`

Direct-play a movie's video file with byte-range (seek) support. Exports both `GET` and `HEAD`.

- **Auth:** Any authenticated (`getRequestUser`); returns `401` `Unauthorized` (plain text) otherwise.
- **Path params:** `id` — movie id.
- **Query params:** `file` — optional numeric movie-file id (selects a specific file when a movie has more than one).
- **Response:** binary video stream, `Content-Type` inferred from file extension (mp4/mkv/webm/…). No `Range` header → `200` full body with `Content-Length` + `Accept-Ranges: bytes`; `Range: bytes=start-end` → `206` partial with `Content-Range`; invalid/unsatisfiable range → `416`. `HEAD` returns the same status/headers with no body. Errors: `401` (plain), `404` `Not Found` (plain) if the media or file is missing.
- **Example:**
  ```bash
  curl -sS -r 0-1048575 "$MEDIABOX_URL/api/v1/stream/movie/12?file=34" \
    -H "x-api-key: $MEDIABOX_API_KEY" -o chunk.bin
  ```

---

## `GET` / `HEAD /api/v1/stream/episode/[id]`

Direct-play an episode's video file with byte-range (seek) support. Exports both `GET` and `HEAD`.

- **Auth:** Any authenticated (`getRequestUser`); `401` otherwise.
- **Path params:** `id` — episode id.
- **Response:** binary video stream with Range support — identical semantics to the movie stream route (`200` full / `206` partial / `416` unsatisfiable; `HEAD` = headers only). Errors: `401` (plain), `404` `Not Found` (plain).
- **Example:**
  ```bash
  curl -sS -I "$MEDIABOX_URL/api/v1/stream/episode/88" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `POST /api/v1/transcode`

Start an on-the-fly HLS transcode session (used when a file can't be direct-played). Returns the session id and its playlist URL.

- **Auth:** Any authenticated (`getRequestUser`); `401` otherwise.
- **Request body:** JSON
  - `type` — `"movie"` | `"episode"` (required).
  - `id` — positive integer, coerced from string (required).
  - `fileId` — positive integer, optional (specific source file).
  - `startSec` — number ≥ 0, optional (seek offset to begin transcoding at).
- **Response:** `200` — `{ "sessionId": "…", "url": "/api/v1/transcode/{sessionId}/index.m3u8" }`. Errors: `400` `Invalid request body` (bad/failed Zod parse), `404` `Media not found`, `429` `{ error }` when the concurrent-session cap is reached, `503` `{ error: "ffmpeg not available" }`, `500`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/transcode" \
    -H "x-api-key: $MEDIABOX_API_KEY" -H "content-type: application/json" \
    -d '{"type":"movie","id":12,"startSec":0}'
  ```

---

## `DELETE /api/v1/transcode/[sessionId]`

Tear down a transcode session (called by the player on modal close/unmount).

- **Auth:** Any authenticated (`getRequestUser`); `401` otherwise.
- **Path params:** `sessionId` — transcode session id.
- **Response:** `204` No Content, empty body (idempotent — unknown ids also return `204`).
- **Example:**
  ```bash
  curl -sS -X DELETE "$MEDIABOX_URL/api/v1/transcode/abc123" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `GET /api/v1/transcode/[sessionId]/[file]`

Serve the HLS playlist or a media segment for an active transcode session. Consumed by hls.js, not called directly.

- **Auth:** Any authenticated (`getRequestUser`); `401` otherwise.
- **Path params:** `sessionId` — session id; `file` — must match `index.m3u8` or `seg#####.ts` (5-digit segment; a whitelist that blocks path traversal).
- **Response:** binary stream. Playlist → `200` `Content-Type: application/vnd.apple.mpegurl`, `Cache-Control: no-cache` (waits up to ~5 s for ffmpeg to flush it). Segment → `200` `Content-Type: video/mp2t`, immutable long-cache. Errors: `400` `Bad Request` (name not whitelisted), `404` `Not Found` (unknown session, or file not produced yet — the client retries).
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/transcode/abc123/index.m3u8" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `GET /api/v1/subtitles`

List downloaded subtitle sidecar tracks available for a movie/episode (for the player's caption menu). First syncs any subtitle files sitting on disk.

- **Auth:** Any authenticated (`getRequestUser`); `401` `{ error: "Not signed in" }` otherwise.
- **Query params:** `movieId` **or** `episodeId` (one required).
- **Response:** `200` — `{ "tracks": [{ "id": 5, "language": "en", "label": "English (SDH)", "url": "/api/v1/subtitles/5/vtt" }] }`. Errors: `400` if neither id given, `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/subtitles?movieId=12" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `POST /api/v1/subtitles/search`

Queue a background subtitle search. Targeted (single title, uncapped) with any of the ids; empty body queues the full backlog scan.

- **Auth:** Any authenticated (proxy-enforced; no in-handler check).
- **Request body:** JSON (optional; defaults to `{}` if body is absent/invalid)
  - `movieId` / `episodeId` / `seriesId` — positive integers, coerced, all optional.
- **Response:** `200` — `{ "queued": true }`. Errors: `400` (Zod validation), `500`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/subtitles/search" \
    -H "x-api-key: $MEDIABOX_API_KEY" -H "content-type: application/json" \
    -d '{"seriesId":7}'
  ```

---

## `GET /api/v1/subtitles/manual`

Interactive subtitle search — return provider candidates for a movie/episode without downloading. Accepts one or several languages (searched together, merged).

- **Auth:** Admin.
- **Query params:** `movieId` **or** `episodeId` (one required); and `languages` (comma-separated) **or** `language` (single) — at least one language required.
- **Response:** `200` — array of candidates: `{ id, providerId, providerName, language, release, hearingImpaired, score }` (`id` is an opaque token for the download POST). Errors: `400` `Provide movieId or episodeId, and language(s)` / `Provide at least one language`, `401`/`403`, `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/subtitles/manual?movieId=12&languages=en,es" \
    -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `POST /api/v1/subtitles/manual`

Download a chosen candidate (by the opaque `id` from the GET) and persist it as a sidecar track.

- **Auth:** Admin.
- **Request body:** JSON
  - `movieId` / `episodeId` — positive integers, coerced, optional (one identifies the target).
  - `candidateId` — non-empty string (required).
- **Response:** `200` — `{ "downloaded": "<path or track ref>" }`. Errors: `400` `Provide movieId or episodeId` or `Candidate expired or failed — search again`, `401`/`403`, `500`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/subtitles/manual" \
    -H "x-api-key: $MEDIABOX_API_KEY" -H "content-type: application/json" \
    -d '{"movieId":12,"candidateId":"opensubtitles:abc"}'
  ```

---

## `POST /api/v1/subtitles/sync-disk`

Discover subtitle files already on disk (sidecars + `Subs/` folders) and register any not yet known so they appear as tracks. Targets a movie, an episode, or a whole series (all its episodes that have files).

- **Auth:** Admin.
- **Request body:** JSON
  - `movieId` / `episodeId` / `seriesId` — positive integers, coerced, all optional; exactly one is used (checked in that order).
- **Response:** `200` — `{ "synced": true }`. Errors: `400` `Provide movieId, episodeId, or seriesId`, `401`/`403`, `500`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/subtitles/sync-disk" \
    -H "x-api-key: $MEDIABOX_API_KEY" -H "content-type: application/json" \
    -d '{"seriesId":7}'
  ```

---

## `GET /api/v1/subtitles/[id]/vtt`

Serve a subtitle sidecar as WebVTT for the in-app player, converting SRT/ASS/SSA on the fly.

- **Auth:** Any authenticated (`getRequestUser`); `401` `{ error: "Not signed in" }` otherwise.
- **Path params:** `id` — subtitle track id.
- **Response:** `200` — WebVTT text, `Content-Type: text/vtt; charset=utf-8`, `Cache-Control: private, max-age=3600`. Errors: `404` `{ error: "Not found" }` (unknown id or unreadable file).
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/subtitles/5/vtt" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `GET /api/v1/subtitles/providers`

List all known subtitle providers and whether each is enabled/ready — drives the settings UI.

- **Auth:** Admin.
- **Response:** `200` — array `{ id, name, description, needsConfig, specializes: string[], enabled, ready }`. Errors: `401`/`403`, `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/subtitles/providers" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `POST /api/v1/subtitles/providers/[id]/test`

Live-test a provider by running a real search (default probe: Inception 2010, which carries tmdb/imdb ids) and reporting how many results came back. Never `500`s — search failures come back as `{ ok: false, error }`.

- **Auth:** Admin.
- **Path params:** `id` — provider id.
- **Request body:** JSON (optional; defaults to `{}`)
  - `title` — string, optional (custom probe title).
  - `year` — integer, coerced, optional.
  - `language` — string, optional (defaults to the first configured subtitle language, else `en`).
- **Response:** `200` on success — `{ ok: true, language, count, tookMs, sample: [{ release, hearingImpaired }] }` (sample capped at 5); on search failure still `200` — `{ ok: false, count: 0, error }`. Errors: `404` `Unknown provider`, `400` `<name> is not configured`, `401`/`403`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/subtitles/providers/opensubtitles/test" \
    -H "x-api-key: $MEDIABOX_API_KEY" -H "content-type: application/json" -d '{}'
  ```

---

## `GET /api/v1/watch-progress`

Fetch the current user's resume point for a movie or episode.

- **Auth:** Any authenticated (`getRequestUser`); `401` `{ error: "Not signed in" }` otherwise.
- **Query params:** `movieId` **or** `episodeId` (one required).
- **Response:** `200` — `{ positionSeconds, durationSeconds, watched }`, or `null` if no progress recorded. Errors: `400` if neither id given, `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/watch-progress?movieId=12" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `PUT /api/v1/watch-progress`

Upsert the current user's resume point (the player PUTs this every ~15 s). Crossing ~90% marks the item watched.

- **Auth:** Any authenticated (`getRequestUser`); `401` otherwise. An API-key principal (no library identity) returns `200 { saved: false }` without writing.
- **Request body:** JSON
  - `movieId` / `episodeId` / `seriesId` — positive integers, coerced, optional (`movieId` or `episodeId` required; `seriesId` is derived for episodes when omitted).
  - `positionSeconds` — number ≥ 0 (required).
  - `durationSeconds` — number ≥ 0 (required).
- **Response:** `200` — `{ "saved": true }` (or `{ "saved": false }` for an API-key user). Errors: `400` `movieId or episodeId is required`, `500`.
- **Example:**
  ```bash
  curl -sS -X PUT "$MEDIABOX_URL/api/v1/watch-progress" \
    -H "x-api-key: $MEDIABOX_API_KEY" -H "content-type: application/json" \
    -d '{"movieId":12,"positionSeconds":600,"durationSeconds":8880}'
  ```

---

## `GET /api/v1/watch-progress/continue`

"Continue watching" feed for the current user: in-progress movies plus the next episode to watch per started series, newest activity first (capped at 20).

- **Auth:** Any authenticated (`getRequestUser`); `401` otherwise.
- **Response:** `200` — array of items:
  ```json
  [
    {
      "kind": "episode",
      "title": "Breaking Bad",
      "subtitle": "S2 · E5 · Breakage",
      "poster": "https://…",
      "backdrop": "https://…",
      "movieId": null,
      "seriesId": 7,
      "episodeId": 88,
      "seasonNumber": 2,
      "episodeNumber": 5,
      "positionSeconds": 300,
      "durationSeconds": 2700,
      "progressPct": 11,
      "watched": false,
      "updatedAt": 1751630400000
    }
  ]
  ```
  Errors: `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/watch-progress/continue" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `GET /api/v1/watch-progress/recent`

Recently finished (watched) movies and episodes for the current user, newest first, one entry per series (capped at 20).

- **Auth:** Any authenticated (`getRequestUser`); `401` otherwise.
- **Response:** `200` — array of items with the same shape as `/continue` (all `watched: true`). Errors: `500`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/watch-progress/recent" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `POST /api/v1/watch-progress/watched`

Mark a movie, episode, or whole series watched/unwatched for the current user.

- **Auth:** Any authenticated (`getRequestUser`); `401` otherwise. An API-key principal returns `200 { watched: false }` without writing.
- **Request body:** JSON
  - `movieId` / `episodeId` / `seriesId` — positive integers, coerced, optional (one of the three required).
  - `watched` — boolean (required).
- **Response:** `200` — `{ "watched": <boolean echoed> }`. Errors: `400` `movieId, episodeId, or seriesId is required`, `500`.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/watch-progress/watched" \
    -H "x-api-key: $MEDIABOX_API_KEY" -H "content-type: application/json" \
    -d '{"seriesId":7,"watched":true}'
  ```

---

## `GET /api/v1/channels`

Live TV landing summary: each channel (movies/series/anime) with its current and next-up program. Materializes the schedule on read.

- **Auth:** Any authenticated (`getRequestUser`); `401` `Unauthorized` (plain) otherwise.
- **Response:** `200` — `{ "channels": [{ "channel": "movies", "serverNow": 1751630400000, "current": <program|null>, "next": <program|null> }] }`. A program is `{ programId, target: { type, id }, title, seriesTitle, episodeLabel, subtitle, posterPath, backdropPath, startAt, endAt, durationSeconds, offsetSeconds, mediaInfo }` (`offsetSeconds` = live seek offset for the current program; `startAt`/`endAt`/`serverNow` are epoch ms).
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/channels" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `GET /api/v1/channels/[kind]`

The program on now (with its seek offset) plus the next few (up to 6) for one channel.

- **Auth:** Any authenticated (`getRequestUser`); `401` `Unauthorized` (plain) otherwise.
- **Path params:** `kind` — one of `movies` | `series` | `anime`.
- **Response:** `200` — `{ "channel", "serverNow", "current": <program|null>, "upNext": <program[]> }` (same program shape as `/channels`). Errors: `404` `Unknown channel` for any other `kind`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/channels/movies" -H "x-api-key: $MEDIABOX_API_KEY"
  ```

---

## `GET /api/v1/channels/[kind]/guide`

The forward-looking lineup (current + upcoming, up to 40 programs) for the TV Guide.

- **Auth:** Any authenticated (`getRequestUser`); `401` `Unauthorized` (plain) otherwise.
- **Path params:** `kind` — one of `movies` | `series` | `anime`.
- **Response:** `200` — `{ "channel", "serverNow", "programs": <program[]> }` (programs still airing/upcoming, same program shape). Errors: `404` `Unknown channel`.
- **Example:**
  ```bash
  curl -sS "$MEDIABOX_URL/api/v1/channels/series/guide" -H "x-api-key: $MEDIABOX_API_KEY"
  ```
