import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { ok, serverError } from "@/lib/http";
import { getJellyfinUrl, getLink, unlinkAccount } from "@/server/jellyfin/jellyfin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The signed-in user's Jellyfin link status. `configured` reflects the global
 * server URL (set by an admin); the rest is this user's own link.
 */
export async function GET(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user || !user.id) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const link = getLink(user.id);
  return ok({
    configured: getJellyfinUrl().length > 0,
    linked: !!link,
    jellyfinUsername: link?.jellyfinUsername ?? null,
    lastSyncAt: link?.lastSyncAt ?? null,
    lastSyncError: link?.lastSyncError ?? null,
  });
}

/** Unlink the signed-in user's Jellyfin account (revokes the token best-effort). */
export async function DELETE(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user || !user.id) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  try {
    await unlinkAccount(user.id);
    return ok({ linked: false });
  } catch (err) {
    return serverError(err);
  }
}
