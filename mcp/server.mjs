#!/usr/bin/env node
/**
 * media-box MCP server — lets an MCP client (Claude Code, etc.) drive the
 * media-box REST API remotely.
 *
 * Zero dependencies: raw JSON-RPC 2.0 over stdio (newline-delimited), Node's
 * global fetch. No build step, no npm install. Requires Node 18+.
 *
 * Config via environment:
 *   MEDIABOX_URL      base URL of the running app (default http://localhost:3000)
 *   MEDIABOX_API_KEY  the app's API key (Settings shows it; treated as admin).
 *                     Optional — without it only mediabox_health works.
 *
 * Run:  node mcp/server.mjs   (usually launched by the MCP client via .mcp.json)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.MEDIABOX_URL || "http://localhost:3000").replace(/\/+$/, "");
const API_KEY = process.env.MEDIABOX_API_KEY || "";
const SERVER_INFO = { name: "media-box", version: "1.0.0" };

function log(...args) {
  process.stderr.write("[media-box-mcp] " + args.join(" ") + "\n");
}

// ---- catalog (auto-generated endpoint index) ---------------------------------

function loadCatalog() {
  try {
    const p = path.resolve(__dirname, "..", "docs", "api", "catalog.json");
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { count: 0, endpoints: [], note: "catalog.json missing — run: node scripts/gen-api-catalog.mjs" };
  }
}

// ---- HTTP to the media-box API ----------------------------------------------

/** Call the API. `apiPath` may be "/movies" (→ /api/v1/movies) or a full "/api/..." path. */
async function callApi(method, apiPath, { query, body, auth = true } = {}) {
  let p = apiPath.startsWith("/") ? apiPath : "/" + apiPath;
  if (!p.startsWith("/api/")) p = "/api/v1" + p;
  const url = new URL(BASE + p);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
  }
  const headers = {};
  if (auth) {
    if (!API_KEY) {
      return { ok: false, status: 0, error: "MEDIABOX_API_KEY is not set — this call needs it. Set it in the MCP env (see mcp/README.md)." };
    }
    headers["x-api-key"] = API_KEY;
  }
  let payload;
  if (body != null && method !== "GET" && method !== "HEAD") {
    headers["content-type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload });
  } catch (err) {
    return { ok: false, status: 0, error: `Cannot reach media-box at ${BASE}: ${err.message}. Is the app running and MEDIABOX_URL correct?` };
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text.length > 4000 ? text.slice(0, 4000) + "…(truncated)" : text;
  }
  return { ok: res.ok, status: res.status, data };
}

// ---- tools -------------------------------------------------------------------

const tools = [
  {
    name: "mediabox_health",
    description: "Check that the media-box app is reachable and its database is up. No API key required.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => callApi("GET", "/health", { auth: false }),
  },
  {
    name: "mediabox_list_endpoints",
    description:
      "List the media-box REST endpoints (method, path, auth, summary) from the auto-generated catalog. Use this to discover what you can call, then use mediabox_request. Optionally filter.",
    inputSchema: {
      type: "object",
      properties: {
        grep: { type: "string", description: "Case-insensitive substring to match against path or summary." },
        method: { type: "string", description: "Filter by HTTP method, e.g. POST." },
      },
      additionalProperties: false,
    },
    handler: async ({ grep, method }) => {
      const cat = loadCatalog();
      let eps = cat.endpoints;
      if (method) eps = eps.filter((e) => e.method.toUpperCase() === String(method).toUpperCase());
      if (grep) {
        const g = String(grep).toLowerCase();
        eps = eps.filter((e) => e.path.toLowerCase().includes(g) || (e.summary || "").toLowerCase().includes(g));
      }
      return { ok: true, status: 200, data: { count: eps.length, endpoints: eps } };
    },
  },
  {
    name: "mediabox_request",
    description:
      "Make an authenticated request to any media-box API endpoint (sends the API key as admin). This is the general-purpose tool for reading or fixing anything. Path is like '/movies' or '/settings' (the /api/v1 prefix is added automatically) or a full '/api/...' path.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method." },
        path: { type: "string", description: "Endpoint path, e.g. '/movies' or '/movies/12' or '/api/v1/queue'." },
        query: { type: "object", description: "Query params as key/value pairs.", additionalProperties: true },
        body: { description: "JSON request body (object) for POST/PUT/PATCH." },
      },
      required: ["method", "path"],
      additionalProperties: false,
    },
    handler: async ({ method, path: p, query, body }) => callApi(String(method).toUpperCase(), p, { query, body }),
  },
  {
    name: "mediabox_run_command",
    description:
      "Enqueue a background command/task (POST /command), e.g. RssSync, WantedSearch, QueueMonitor, RefreshMovies, RefreshSeries, SubtitleSearch. Optionally pass a payload.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Command name (see server/jobs/handlers/index.ts)." },
        payload: { description: "Optional command-specific payload object." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: async ({ name, payload }) => callApi("POST", "/command", { body: { name, payload } }),
  },
  {
    name: "mediabox_set_file_operations",
    description:
      "Toggle the master read-only switch (fileOperationsEnabled). When false, media-box never moves, renames, or deletes media files. Convenience wrapper over PUT /settings.",
    inputSchema: {
      type: "object",
      properties: { enabled: { type: "boolean", description: "true = allow file operations, false = read-only." } },
      required: ["enabled"],
      additionalProperties: false,
    },
    handler: async ({ enabled }) => callApi("PUT", "/settings", { body: { fileOperationsEnabled: Boolean(enabled) } }),
  },
];

const toolByName = new Map(tools.map((t) => [t.name, t]));

// ---- JSON-RPC / MCP plumbing -------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Drive the media-box PVR REST API. Start with mediabox_list_endpoints to discover routes, then mediabox_request to call them. mediabox_health needs no key.",
      });
      return;
    case "notifications/initialized":
    case "initialized":
      return; // notification, no response
    case "ping":
      if (!isNotification) reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    case "tools/call": {
      const tool = toolByName.get(params?.name);
      if (!tool) {
        replyError(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      try {
        const result = await tool.handler(params.arguments || {});
        const isError = result && result.ok === false;
        reply(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: Boolean(isError),
        });
      } catch (err) {
        reply(id, {
          content: [{ type: "text", text: `Tool error: ${err?.message || err}` }],
          isError: true,
        });
      }
      return;
    }
    default:
      if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
  }
}

// Read newline-delimited JSON from stdin.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      log("bad JSON:", err.message);
      continue;
    }
    handle(msg).catch((err) => log("handler crashed:", err?.message || String(err)));
  }
});
process.stdin.on("end", () => process.exit(0));

log(`ready — base=${BASE} key=${API_KEY ? "set" : "MISSING"}`);
