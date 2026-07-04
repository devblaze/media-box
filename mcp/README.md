# media-box MCP server

A tiny **Model Context Protocol** server that lets an MCP client (Claude Code,
Claude Desktop, etc.) drive the media-box REST API — so the assistant can
inspect state and *fix things* through the API instead of only editing code.

It's **zero-dependency**: raw JSON-RPC over stdio using Node's built-in `fetch`.
No `npm install`, no build step. Requires **Node 18+**.

## What it exposes

| Tool | What it does |
| --- | --- |
| `mediabox_health` | Ping the app (no API key needed). |
| `mediabox_list_endpoints` | List every REST endpoint from the auto-generated catalog (`grep` / `method` filters). Discover first, then call. |
| `mediabox_request` | Authenticated call to **any** endpoint: `{ method, path, query?, body? }`. The workhorse. |
| `mediabox_run_command` | Enqueue a background task (`RssSync`, `WantedSearch`, `RefreshMovies`, …). |
| `mediabox_set_file_operations` | Flip the master read-only switch (`fileOperationsEnabled`). |

The full endpoint reference lives in [`../docs/api/`](../docs/api/README.md).

## Configuration

Two environment variables:

| Var | Default | Notes |
| --- | --- | --- |
| `MEDIABOX_URL` | `http://localhost:3000` | Base URL of the running app. |
| `MEDIABOX_API_KEY` | *(empty)* | The app's API key — sent as `x-api-key` and treated as **admin**. Without it, only `mediabox_health` works. |

**Get the API key:** in the app, go to **Settings → General → Security → “API Key
(for external tools)”**. (Or `GET /api/v1/settings` with an admin session and read
`apiKey`.) Treat it like a password.

## Use it from Claude Code (this repo)

A project-scoped [`.mcp.json`](../.mcp.json) is already committed. It launches this
server and reads the two env vars (so **no secret is committed**). Set the key in
your shell before starting Claude Code:

```bash
export MEDIABOX_API_KEY="paste-the-key-here"
# optional if the app isn't on localhost:3000:
export MEDIABOX_URL="http://your-host:3000"
```

Then open the repo in Claude Code and approve the `media-box` MCP server when
prompted (`/mcp` lists its status and tools).

## Use it from any other MCP client

Register a stdio server with:

- **command:** `node`
- **args:** `["mcp/server.mjs"]` (or an absolute path to `server.mjs`)
- **env:** `MEDIABOX_URL`, `MEDIABOX_API_KEY`

e.g. `claude mcp add media-box -- node /abs/path/to/mcp/server.mjs` (then set the
env vars), or the equivalent block in Claude Desktop's `claude_desktop_config.json`.

## Quick smoke test (no client needed)

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mediabox_health","arguments":{}}}' \
  | MEDIABOX_URL="http://localhost:3000" node mcp/server.mjs
```

## Keeping it current

The endpoint catalog it serves is generated from the route files. After adding,
removing, or renaming an API route, regenerate it:

```bash
node scripts/gen-api-catalog.mjs   # rewrites docs/api/catalog.json
```

New endpoints are reachable through `mediabox_request` **immediately** (it's a
generic passthrough) — regenerating the catalog just keeps `mediabox_list_endpoints`
and the prose docs in sync. See [`../docs/api/README.md`](../docs/api/README.md#keeping-these-docs-current).
