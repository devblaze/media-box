<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# REST API — docs & remote control

- The app's REST API lives under `app/api/v1/**/route.ts`. Its **reference wiki** is
  [`docs/api/`](docs/api/README.md), split by area, plus a machine-readable
  [`docs/api/catalog.json`](docs/api/catalog.json).
- **Keep the docs in sync with the routes.** When you add, remove, or change any
  `app/api/**/route.ts` (path, method, auth guard, Zod body, response shape):
  1. Run `node scripts/gen-api-catalog.mjs` to regenerate `docs/api/catalog.json`.
  2. Update the matching page under `docs/api/` (method, path, auth, params, body
     table, response, curl example — follow the existing format).
  A route change with stale docs is an incomplete change.
- **Remote control:** `mcp/server.mjs` is a zero-dependency MCP server (stdio) that
  drives this API — use it to inspect or fix a running instance instead of only
  editing code. Auth is `x-api-key: <apiKey>` (Settings → General → Security; treated
  as admin). A project `.mcp.json` is wired up; setup is in [`mcp/README.md`](mcp/README.md).
- **Read-only mode:** `fileOperationsEnabled` (a setting) is a master switch — when
  false, media-box never moves/renames/deletes media files (enforced centrally in
  `server/library/media-guard.ts` + `filesystem.ts`). Endpoints that touch files
  return `409` while it's off.
