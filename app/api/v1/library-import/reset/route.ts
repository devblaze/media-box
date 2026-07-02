import type { NextRequest } from "next/server";
import { requireAdmin } from "@/server/auth/guards";
import { resetLibrary } from "@/server/library/reset-service";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Remove every library entry from the database (movies, series, and their files).
 * DB-ONLY — files on disk are NOT touched and can be re-imported. Returns the
 * number of rows deleted per table.
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    return ok(resetLibrary());
  } catch (err) {
    return serverError(err);
  }
}
