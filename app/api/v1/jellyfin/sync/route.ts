import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { ok, badRequest, serverError } from "@/lib/http";
import { getLink } from "@/server/jellyfin/jellyfin-service";
import { syncUser } from "@/server/jellyfin/jellyfin-sync";
import { JellyfinError } from "@/server/jellyfin/jellyfin-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sync the signed-in user's Jellyfin watch state now (Continue Watching +
 * Next Up → watch_progress). Runs inline so the caller can refresh immediately.
 */
export async function POST(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user || !user.id) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!getLink(user.id)) return badRequest("No Jellyfin account linked");
  try {
    return ok(await syncUser(user.id));
  } catch (err) {
    if (err instanceof JellyfinError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return serverError(err);
  }
}
