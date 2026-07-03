import type { NextRequest } from "next/server";
import { requireAdmin } from "@/server/auth/guards";
import { getActiveStreams } from "@/server/users/user-activity-service";
import { ok, serverError } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Who is streaming right now — for the admin dashboard "Now streaming" card. */
export async function GET(request: NextRequest) {
  try {
    const denied = requireAdmin(request);
    if (denied) return denied;
    return ok(getActiveStreams());
  } catch (err) {
    return serverError(err);
  }
}
