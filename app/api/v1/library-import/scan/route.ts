import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { requireAdmin } from "@/server/auth/guards";
import { scanLibrary } from "@/server/library/library-import";
import { badRequest, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scan a library root folder for on-disk titles not yet imported, matching each
 * against TMDB. `type` is "movie" | "series"; the folder scanned is the root
 * folder identified by `rootFolderId`.
 */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const type = request.nextUrl.searchParams.get("type");
  const rootFolderId = Number(request.nextUrl.searchParams.get("rootFolderId"));
  if (type !== "movie" && type !== "series") {
    return badRequest("?type= must be 'movie' or 'series'");
  }
  if (!Number.isInteger(rootFolderId)) return badRequest("?rootFolderId= is required");

  try {
    const rf = getDb()
      .select()
      .from(schema.rootFolders)
      .where(eq(schema.rootFolders.id, rootFolderId))
      .get();
    if (!rf) return badRequest("Unknown root folder");
    const candidates = await scanLibrary(type, rf.path);
    return ok({ root: rf.path, candidates });
  } catch (err) {
    return serverError(err);
  }
}
