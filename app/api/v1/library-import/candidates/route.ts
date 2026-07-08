import type { NextRequest } from "next/server";
import { requirePermission } from "@/server/auth/guards";
import { loadScanCandidates } from "@/server/library/library-import";
import { badRequest, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The not-yet-imported candidates from the last scan of `type`, so the Library
 * Import page can reload a prior scan (leaving/returning keeps the unmatched list
 * without rescanning). Imported rows have already dropped off.
 */
export async function GET(request: NextRequest) {
  const denied = requirePermission(request, "libraryImport.access");
  if (denied) return denied;

  const type = request.nextUrl.searchParams.get("type");
  if (type !== "movie" && type !== "series" && type !== "anime") {
    return badRequest("?type= must be 'movie', 'series' or 'anime'");
  }

  try {
    const candidates = loadScanCandidates(type);
    return ok({ candidates });
  } catch (err) {
    return serverError(err);
  }
}
