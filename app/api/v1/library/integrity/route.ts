import type { NextRequest } from "next/server";
import { requireAdmin } from "@/server/auth/guards";
import { checkLibraryIntegrity } from "@/server/library/integrity";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Compare the library the database describes against the one on disk.
 *
 * Read-only. `?orphans=true` additionally sweeps every series folder for video
 * files no row points at — the copies that make an episode look missing and get
 * it downloaded a second time. That sweep reads every library folder, so it is
 * opt-in rather than the default.
 */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const includeOrphans = request.nextUrl.searchParams.get("orphans") === "true";
    return ok(await checkLibraryIntegrity({ includeOrphans }));
  } catch (err) {
    return serverError(err);
  }
}
