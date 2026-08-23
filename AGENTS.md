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

# Local dev on macOS: iCloud can gut `node_modules`

If your checkout lives under an iCloud-synced folder (`~/Documents`, `~/Desktop`),
macOS reclaims space by turning `node_modules` files into **dataless
placeholders**. They still `stat` at full size, but the first read blocks until
iCloud fetches them back — so every `require()` waits on the network. Measured
here: `eslint` went from **6 seconds to over 10 minutes**, `tsc` the same, and a
partially-materialised read can surface as a bogus "X is not a constructor".

Check it:

```bash
yarn doctor      # samples node_modules for iCloud placeholders
```

Repair by **reinstalling** — pulling 200 MB back out of iCloud is far slower than
refetching it from the package cache (46s vs. hours, measured):

```bash
rm -rf node_modules && yarn install --frozen-lockfile
```

Do **not** try the usual `node_modules.nosync` + symlink trick: Turbopack decides
what to treat as an external package by path, so with the real directory named
something other than `node_modules` it bundles `better-sqlite3` instead of
externalising it, and `next dev` dies looking for `better_sqlite3.node` under
`.next/dev/`. Everything else (lint, tsc, tests, `next build`) survives it — the
dev server does not.

The durable fixes are to move the checkout out of the synced folder, or to turn
off System Settings → Apple Account → iCloud → iCloud Drive → "Optimise Mac
Storage". Moving it out is worth doing anyway: sync has also duplicated files
inside `.git` here before, which broke `git pull`.
