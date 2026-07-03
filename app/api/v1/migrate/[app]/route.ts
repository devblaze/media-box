import type { NextRequest } from "next/server";
import { z } from "zod";
import { preview, type App } from "@/server/migration/migrate-service";
import { enqueueCommand } from "@/server/jobs/scheduler";
import { setSetting } from "@/server/settings/settings-service";
import { badRequest, ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

const connSchema = z.object({
  url: z.string().url(),
  apiKey: z.string().min(1),
});

const executeSchema = z.object({
  conn: connSchema,
  decisions: z.object({
    profileMap: z.record(z.string(), z.union([z.number(), z.literal("create")])),
    pathRewrites: z.array(z.object({ from: z.string(), to: z.string() })),
    importIndexers: z.boolean(),
    importClients: z.boolean(),
    rootFolderId: z.number().int(),
    rootFolderMap: z.record(z.string(), z.number().int()).optional(),
  }),
});

function parseApp(app: string): App | null {
  return app === "sonarr" || app === "radarr" ? app : null;
}

// POST = connect & preview
export async function POST(request: NextRequest, ctx: RouteContext<"/api/v1/migrate/[app]">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { app } = await ctx.params;
    const parsedApp = parseApp(app);
    if (!parsedApp) return badRequest("Unknown app — use sonarr or radarr");
    const conn = connSchema.parse(await request.json());
    const result = await preview(parsedApp, conn);
    // Connection worked — remember the credentials so the wizard can prefill
    // them next time (per app, so Sonarr and Radarr are kept separately).
    if (parsedApp === "sonarr") {
      setSetting("sonarrUrl", conn.url);
      setSetting("sonarrApiKey", conn.apiKey);
    } else {
      setSetting("radarrUrl", conn.url);
      setSetting("radarrApiKey", conn.apiKey);
    }
    return ok(result);
  } catch (err) {
    return serverError(err);
  }
}

// PUT = execute (queued as a background command)
export async function PUT(request: NextRequest, ctx: RouteContext<"/api/v1/migrate/[app]">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { app } = await ctx.params;
    const parsedApp = parseApp(app);
    if (!parsedApp) return badRequest("Unknown app — use sonarr or radarr");
    const { conn, decisions } = executeSchema.parse(await request.json());
    const id = enqueueCommand(
      "ExecuteMigration",
      { app: parsedApp, conn, decisions },
      "manual",
      10
    );
    return ok({ commandId: id, queued: id !== null }, { status: 202 });
  } catch (err) {
    return serverError(err);
  }
}
