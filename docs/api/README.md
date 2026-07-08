# media-box API

media-box exposes a REST API under **`/api/v1`**. This is the same API the web UI
uses, so anything the UI can do is scriptable. It's also how the assistant
remote-controls a running instance (see [MCP](#remote-control-mcp)).

- **Base URL:** `http://<host>:3000` (dev default `http://localhost:3000`; the
  container serves on port 3000 behind whatever you map it to).
- **All paths** below are relative to `${MEDIABOX_URL}/api/v1`.
- **Content type:** JSON in, JSON out (except binary stream/HLS and SSE routes).

## Authentication

Every request must be authenticated one of two ways:

1. **Session cookie** — issued by `POST /api/v1/auth/login`; this is what the browser uses.
2. **API key header** — `x-api-key: <apiKey>`. An API-key request is treated as a
   synthetic **admin** and is the recommended way to script the API. Find the key in
   the UI under **Settings → General → Security → “API Key (for external tools)”**,
   or read `apiKey` from `GET /api/v1/settings` with an admin session.

Anonymous requests are rejected at the edge with `401`. A handful of routes are
public (no auth): `GET /health`, `POST /auth/login`, `GET|POST /auth/setup`,
`POST /auth/kiosk`.

> **Per-endpoint auth varies.** Some routes additionally require `admin`; some
> require any signed-in `user`; some are gated only by the edge presence check
> (marked `session` in the catalog). Each endpoint page states its level, and
> `docs/api/catalog.json` records it per method.

```bash
export MEDIABOX_URL="http://localhost:3000"
export MEDIABOX_API_KEY="…"      # Settings → General → Security
curl -sS "$MEDIABOX_URL/api/v1/movies" -H "x-api-key: $MEDIABOX_API_KEY"
```

## Conventions

- **Success:** `200` (or `201` on create) with a JSON body. Some actions return
  `{ "deleted": true }` / `{ "saved": false }`-style acknowledgements.
- **Errors:** JSON `{ "error": "message" }` with an appropriate status:
  - `400` bad input (Zod validation failures include an `issues` array)
  - `401` not authenticated · `403` not authorized (admin required)
  - `404` not found · `409` conflict
  - `423`/`409` **read-only mode** — see below · `500` server error
- **Read-only mode:** when the admin turns **“Allow file operations”** off
  (`fileOperationsEnabled: false`), any endpoint that would move, rename, or delete
  media files is refused with a **`409`** and a clear message. Downloads still run
  and auto-import once it's re-enabled. Toggle via `PUT /settings`.

## Endpoint reference

| Area | File | What's in it |
| --- | --- | --- |
| Auth, Users & Account | [auth-and-users.md](./auth-and-users.md) | login/setup/logout, sessions, users, account, kiosk tokens |
| Library | [library.md](./library.md) | movies, series, episodes, wanted, root folders, naming, lookup, discover, calendar |
| Acquisition | [acquisition.md](./acquisition.md) | indexers, download clients, queue, releases, requests, history, background commands |
| System & Settings | [system-and-settings.md](./system-and-settings.md) | settings, quality profiles/definitions, system status & tasks, logs, AI assistant, versions, health, fs, library-import, organizer, migrate |
| Playback & Channels | [playback-and-channels.md](./playback-and-channels.md) | streams, transcode, subtitles, watch progress, watch-together, live-TV channels |

**Machine-readable index:** [`catalog.json`](./catalog.json) — every `{ method, path,
auth, summary }`, auto-generated from the route files. The MCP server serves it via
`mediabox_list_endpoints`.

## Remote control (MCP)

An MCP server in [`../../mcp/`](../../mcp/README.md) wraps this API so an MCP client
(Claude Code, etc.) can operate media-box directly — discover endpoints, read state,
and apply fixes without editing code. It's zero-dependency Node over stdio. See
[`mcp/README.md`](../../mcp/README.md) for setup; a project `.mcp.json` is already
wired up.

## Keeping these docs current

**When you add, change, or remove an API route, update the docs in the same change:**

1. **Regenerate the catalog** (auto — reads the route files):
   ```bash
   node scripts/gen-api-catalog.mjs
   ```
2. **Edit the matching area page** above (add/adjust the `##` section: method, path,
   auth, params, body table, response, curl example). Match the existing format.
3. If you added a whole new area, add a row to the table above and a new page.
4. New endpoints work through the MCP `mediabox_request` tool immediately; the steps
   above keep discovery (`mediabox_list_endpoints`) and this reference in sync.

> This file and its siblings are the source of truth for the API surface. Treat a
> route change with stale docs as an incomplete change.
