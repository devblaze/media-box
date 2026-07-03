import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { requireAdmin } from "@/server/auth/guards";
import { scanLibrary, persistScanCandidates } from "@/server/library/library-import";
import { badRequest, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scan a library root folder for on-disk titles not yet imported, matching each
 * against TMDB. `type` is "movie" | "series" | "anime"; the folder scanned is the
 * root folder identified by `rootFolderId`.
 */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const type = request.nextUrl.searchParams.get("type");
  const rootFolderId = Number(request.nextUrl.searchParams.get("rootFolderId"));
  const qualityProfileRaw = Number(request.nextUrl.searchParams.get("qualityProfileId"));
  const qualityProfileId =
    Number.isInteger(qualityProfileRaw) && qualityProfileRaw > 0 ? qualityProfileRaw : null;
  if (type !== "movie" && type !== "series" && type !== "anime") {
    return badRequest("?type= must be 'movie', 'series' or 'anime'");
  }
  if (!Number.isInteger(rootFolderId)) return badRequest("?rootFolderId= is required");

  try {
    const rf = getDb()
      .select()
      .from(schema.rootFolders)
      .where(eq(schema.rootFolders.id, rootFolderId))
      .get();
    if (!rf) return badRequest("Unknown root folder");
    const { candidates, truncated } = await scanLibrary(type, rf.path);
    // Persist the scan so the unmatched titles survive navigation without rescanning.
    persistScanCandidates(type, rootFolderId, qualityProfileId, candidates);
    return ok({ root: rf.path, candidates, truncated });
  } catch (err) {
    return serverError(err);
  }
}
