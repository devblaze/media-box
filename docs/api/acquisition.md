# Acquisition (Indexers, Downloads, Queue, Requests, Commands)

Endpoints that acquire media: Torznab indexers, download clients, the download
queue, interactive release search/grab, user requests, history, and background
commands.

**Auth.** Every request must carry either the session cookie or an
`x-api-key: <apiKey>` header (an API key is treated as an admin). At the handler
level each route additionally applies one of:

- **admin** — `requireAdmin` (401 if unauthenticated, 403 if not an admin).
- **user** — a signed-in user; some routes scope results to the caller.
- **any** — no handler-level guard beyond the cookie/api-key presence enforced by the proxy.

**Response envelopes.** `ok` → 200 (unless a `status` is passed), validation
failures → 400 `{ error: "Validation failed", issues }`, `badRequest` → 400,
`notFound` → 404, read-only conflict (`MediaWritesDisabledError`) → 409, other
errors → 500. All error bodies are `{ error }`.

---

## `GET /api/v1/indexers`

List all indexers, ordered by ascending `priority`.

- **Auth:** admin
- **Response:** `200` — array of indexer rows (includes `id`, `name`, `url`, `apiKey`, `categories`, `enableRss`, `enableAutomaticSearch`, `enableInteractiveSearch`, `minimumSeeders`, `priority`, `enabled`, `supportsTv`, `supportsMovies`).

## `POST /api/v1/indexers`

Create an indexer. Capabilities (`supportsTv`/`supportsMovies`) are probed from
the Torznab caps endpoint on save; if probing fails both default to `true`.

- **Auth:** admin
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | name | string | yes | — | min length 1 |
  | url | string (url) | yes | — | Torznab base URL |
  | apiKey | string \| null | no | null | |
  | categories | number[] | no | — | integer Torznab category ids |
  | enableRss | boolean | no | — | |
  | enableAutomaticSearch | boolean | no | — | |
  | enableInteractiveSearch | boolean | no | — | |
  | minimumSeeders | integer | no | — | ≥ 0 |
  | priority | integer | no | — | 1–50 |
  | enabled | boolean | no | — | |

- **Response:** `201` — the created indexer row.

## `PUT /api/v1/indexers/[id]`

Partial update of an indexer. Body is the create schema made partial; an omitted
`apiKey` keeps the stored value.

- **Auth:** admin
- **Path params:** `id` — indexer id.
- **Request body:** any subset of the `POST /indexers` fields.
- **Response:** `200` — the updated indexer row. `404` if not found.

## `DELETE /api/v1/indexers/[id]`

Delete an indexer.

- **Auth:** admin
- **Path params:** `id` — indexer id (must be an integer).
- **Response:** `200` — `{ deleted: true }`. `400` on non-integer id.

## `POST /api/v1/indexers/test`

Probe a Torznab endpoint's caps without saving. Connection failures are returned
as `200 { ok: false }`, not an error status.

- **Auth:** admin
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | url | string (url) | yes | — | |
  | apiKey | string \| null | no | null | |

- **Response:** `200` — on success `{ ok: true, message, caps }` where `caps = { tvSearchAvailable, movieSearchAvailable, categories: [{ id, name }] }`; on failure `{ ok: false, message }`.

---

## `GET /api/v1/downloadclients`

List download clients ordered by ascending `priority`. Secret settings
(`password`, `apiKey`) are redacted to `••••••••`.

- **Auth:** admin
- **Response:** `200` — array of client rows (`id`, `name`, `type`, `settings` (redacted), `enabled`, `priority`, `removeCompletedDownloads`).

## `POST /api/v1/downloadclients`

Create a download client. Body is a discriminated union on `type`.

- **Auth:** admin
- **Request body (common):**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | type | `"qbittorrent"` \| `"torbox"` | yes | — | discriminator |
  | name | string | yes | — | min length 1 |
  | settings | object | yes | — | shape depends on `type` (below) |
  | enabled | boolean | no | — | |
  | priority | integer | no | — | ≥ 1 |
  | removeCompletedDownloads | boolean | no | — | |

  `settings` for `type: "qbittorrent"`:

  | field | type | required | default |
  | --- | --- | --- | --- |
  | host | string | yes | — |
  | port | integer | no | 8080 |
  | useSsl | boolean | no | false |
  | username | string | no | "" |
  | password | string | no | "" |
  | category | string | no | "media-box" |

  `settings` for `type: "torbox"`:

  | field | type | required | default |
  | --- | --- | --- | --- |
  | apiKey | string | yes | — |
  | stagingDir | string | no | "/data/torbox" |

- **Response:** `201` — the created client row (secrets redacted).

## `PUT /api/v1/downloadclients/[id]`

Update a download client. `type` is fixed to the stored value. Secret fields
sent as the redaction placeholder `••••••••` retain their stored values.

- **Auth:** admin
- **Path params:** `id` — client id.
- **Request body:** same shape as `POST /downloadclients` (minus `type`, which is inherited from the stored row).
- **Response:** `200` — `{ updated: true }`. `404` if not found.

## `DELETE /api/v1/downloadclients/[id]`

Delete a download client.

- **Auth:** admin
- **Path params:** `id` — client id (must be an integer).
- **Response:** `200` — `{ deleted: true }`. `400` on non-integer id.

## `POST /api/v1/downloadclients/test`

Test connectivity to a saved or unsaved client. Failures return `200 { ok: false }`.

- **Auth:** admin
- **Request body:** either `{ id: integer }` (test a saved client using stored secrets) **or** a full create body (`type` + `name` + `settings`, per `POST /downloadclients`).
- **Response:** `200` — `{ ok: boolean, message? }`. Unknown saved id → `{ ok: false, message: "Client not found" }`.

---

## `GET /api/v1/remotepathmappings`

List all remote-path mappings.

- **Auth:** admin
- **Response:** `200` — array of mapping rows (`id`, `downloadClientId`, `remotePath`, `localPath`).

## `POST /api/v1/remotepathmappings`

Create a remote-path mapping.

- **Auth:** admin
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | downloadClientId | integer | yes | — | |
  | remotePath | string | yes | — | min length 1 |
  | localPath | string | yes | — | min length 1 |

- **Response:** `201` — the created mapping row.

## `DELETE /api/v1/remotepathmappings`

Delete a mapping by query id.

- **Auth:** admin
- **Query params:** `id` (integer, required).
- **Response:** `200` — `{ deleted: true }`. `400` on missing/non-integer `?id=`.

---

## `GET /api/v1/queue`

Active download queue: rows whose status is one of `queued`, `downloading`,
`remoteCompleted`, `fetching`, `importPending`, `importing`, `warning`,
`failed`, newest first.

- **Auth:** any
- **Response:** `200` — array of `{ id, title, status, statusMessage, mediaType, seriesId, movieId, size, sizeLeft, quality, grabbedAt, clientName, clientType }`.

## `POST /api/v1/queue/[id]`

Retry the import of a queue item (enqueues an `ImportDownload` command).

- **Auth:** any
- **Path params:** `id` — download id.
- **Response:** `200` — `{ retrying: true }`. `404` if the item is not found.

## `DELETE /api/v1/queue/[id]`

Remove a queue item; optionally blocklist the release and/or remove it from the
download client.

- **Auth:** any
- **Path params:** `id` — download id (must be an integer).
- **Query params:** `blocklist` (`true` to add to the blocklist; default off), `removeFromClient` (defaults on — pass `false` to keep the data in the client).
- **Response:** `200` — `{ deleted: true }`. `404` if not found, `400` on non-integer id.

---

## `GET /api/v1/release`

Interactive release search. Provide exactly one target via query params; results
are searched live across enabled interactive-search indexers (not cached).

- **Auth:** any
- **Query params:** one of `episodeId`, `movieId`, or `seriesId` **plus** `season`.
- **Response:** `200` — array of decorated releases, each `{ guid, indexerId, indexerName, title, size, seeders, leechers, downloadUrl, magnetUrl, infoHash, publishDate, parsed, accepted, rejections, score }`, sorted accepted-first then by score then indexer priority. `400` if no valid target is given.

## `POST /api/v1/release`

Grab a specific release. The server re-runs the interactive search for the given
target and matches the chosen release by `guid` (results are not cached), then
hands it to the download service.

- **Auth:** any
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | guid | string | yes | — | release guid from a prior `GET /release` |
  | episodeId | integer | no | — | target selector |
  | movieId | integer | no | — | target selector |
  | seriesId | integer | no | — | pair with `season` for a season target |
  | season | integer | no | — | pair with `seriesId` |
  | override | boolean | no | false | "Grab anyway" — import even if not an upgrade |

- **Response:** `201` — the created download row (or `{ externalId }` fallback). `400` if no target is derivable or the release is no longer available. Grab failures (e.g. no enabled client) surface as `500`.

---

## `GET /api/v1/requests`

List requests, newest first. Admins see all; other users see only their own.

- **Auth:** user (signed in; `401` otherwise)
- **Response:** `200` — array of `{ id, mediaType, tmdbId, title, year, posterPath, seasons, status, declineReason, createdAt, userId, username, movieId, seriesId }`.

## `POST /api/v1/requests`

Create a request. Rejects the kiosk/guest user (`id === 0`). When
`requestsAutoApprove` is enabled the media is added straight to the library; if
approval fails it is left `pending`.

- **Auth:** user (signed in, real account; `401`/`400` otherwise)
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | mediaType | `"series"` \| `"movie"` | yes | — | |
  | tmdbId | integer | yes | — | positive |
  | title | string | yes | — | min length 1 |
  | year | integer \| null | no | null | |
  | posterPath | string \| null | no | null | |
  | seasons | number[] \| null | no | null | requested season numbers |

- **Response:** `201` — the created (or auto-approved) request row. `409` if the same tmdbId+mediaType was already requested by this user.

## `PUT /api/v1/requests/[id]`

Approve or decline a request (admin decision). Approving adds the media to the
library and kicks off a search.

- **Auth:** admin
- **Path params:** `id` — request id.
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | action | `"approve"` \| `"decline"` | yes | — | |
  | reason | string | no | — | decline reason |

- **Response:** `200` — `{ status: "approved" }` or `{ status: "declined" }`. `404` if not found, `400` if declining a non-pending request.

## `DELETE /api/v1/requests/[id]`

Delete a request. Owners may delete their own; admins may delete any.

- **Auth:** user (owner or admin)
- **Path params:** `id` — request id.
- **Response:** `200` — `{ deleted: true }`. `404` if not found, `403` if not the owner and not an admin.

---

## `GET /api/v1/history`

Recent history events, newest first.

- **Auth:** any
- **Query params:** `limit` (default 100, capped at 500).
- **Response:** `200` — array of `{ id, eventType, mediaType, sourceTitle, quality, date, seriesId, movieId, seriesTitle, movieTitle, data }`.

## `GET /api/v1/history/failures`

Failed download/grab/import attempts (`downloadFailed` events) for the admin
failures calendar.

- **Auth:** admin
- **Query params:** `start`, `end` (ISO dates). Default window is the last 60 days ending now.
- **Response:** `200` — array of `{ id, date, mediaType, seriesId, movieId, episodeId, seriesTitle, movieTitle, sourceTitle, quality, data }`.

---

## `GET /api/v1/command`

List queued commands, newest first.

- **Auth:** admin
- **Query params (pagination is opt-in via `page`):**

  | param | type | default | notes |
  | --- | --- | --- | --- |
  | page | integer | — | 0-based page index. Presence switches on paginated mode. |
  | pageSize | integer | 20 | rows per page (max 100) |

- **Response (default, no `page`):** `200` — array of the 50 most recent command rows (`id`, `name`, `payload`, `trigger`, `priority`, `status`, `queuedAt`, `startedAt`, `endedAt`, `result`/`error`, …).
- **Response (paginated, with `page`):** `200` — `{ items: CommandRow[], total, page, pageSize }`. `total` is the full row count so a UI can render "page N of M" (useful when a mass re-import queues thousands of commands).

## `POST /api/v1/command`

Enqueue a background command (task). Duplicate suppression: an identical
name+payload already `queued` or `started` is deduped (no new row).

- **Auth:** admin
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | name | string | yes | — | registered command name (see below) |
  | payload | object | no | null | command-specific; e.g. `{ downloadId }` for `ImportDownload`, `{ seriesId }`/`{ movieId }` for `WantedSearch` |

  Registered command names: `Housekeeping`, `RefreshSeries`, `RefreshMovies`,
  `DiskScan`, `RssSync`, `WantedSearch`, `SubtitleSearch`, `QueueMonitor`,
  `LibraryImportBatch`, `ChannelScheduler`, `FetchTorboxFiles`, `ImportDownload`,
  `ExecuteMigration`. (An unregistered name still enqueues but fails at run time.)

- **Response:** `201` — `{ id, queued: true }` when enqueued; `200` — `{ id: null, queued: false }` when deduped. Errors: `400` on bad body.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/command" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H 'content-type: application/json' -d '{"name":"RssSync"}'
  ```

---

## `POST /api/v1/monitoring/bulk`

Bulk-set the `monitored` flag on many movies/series, or bulk-apply a series
monitor mode, in a single request.

- **Auth:** admin
- **Request body:**

  | field | type | required | default | notes |
  | --- | --- | --- | --- | --- |
  | items | array (min 1) | yes | — | each `{ type: "movie" \| "series", id: positive int, monitored?: boolean }` |
  | monitorMode | `"all"` \| `"future"` \| `"none"` | no | — | when set, re-derives season/episode flags for the series items instead of a plain on/off |

- **Response:** `200` — `{ updated }` (count of series when `monitorMode` is used, otherwise rows changed). `400` if neither `monitorMode` nor any item `monitored` is provided.
- **Example:**
  ```bash
  curl -sS -X POST "$MEDIABOX_URL/api/v1/monitoring/bulk" -H "x-api-key: $MEDIABOX_API_KEY" \
    -H 'content-type: application/json' \
    -d '{"items":[{"type":"series","id":12},{"type":"movie","id":4,"monitored":false}]}'
  ```
