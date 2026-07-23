import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getRequestUser } from "@/server/auth/auth-service";
import { ok, badRequest, serverError } from "@/lib/http";
import { getJellyfinUrl, linkAccount } from "@/server/jellyfin/jellyfin-service";
import { syncUser, type SyncResult } from "@/server/jellyfin/jellyfin-sync";
import { JellyfinError } from "@/server/jellyfin/jellyfin-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string(),
});

/**
 * Link the signed-in media-box user to their own Jellyfin account: exchange the
 * credentials for a token (the password is forwarded to Jellyfin, never stored)
 * and run the first watch-state sync inline so the profile is up to date on
 * return. A failed first sync does not undo the link.
 */
export async function POST(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user || !user.id) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!getJellyfinUrl()) return badRequest("No Jellyfin server configured — ask an admin.");

  let input: z.infer<typeof loginSchema>;
  try {
    input = loginSchema.parse(await request.json());
  } catch {
    return badRequest("Invalid request body");
  }

  try {
    const link = await linkAccount(user.id, input.username.trim(), input.password);
    let sync: SyncResult | null = null;
    let syncError: string | null = null;
    try {
      sync = await syncUser(user.id);
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
    }
    return ok(
      { linked: true, jellyfinUsername: link.jellyfinUsername, sync, syncError },
      { status: 201 }
    );
  } catch (err) {
    // Wrong credentials / unreachable server both surface as a clear 400 message.
    if (err instanceof JellyfinError) {
      return badRequest(err.message);
    }
    return serverError(err);
  }
}
