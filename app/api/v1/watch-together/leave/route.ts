import type { NextRequest } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { emitEvent } from "@/server/events/bus";
import { hostOf, leave } from "@/server/watch-together/session";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stop watching along with a host. Deregisters the joiner and, if they were
 * following someone, toasts that host ("… left your stream").
 */
export async function POST(request: NextRequest) {
  const me = getRequestUser(request);
  if (!me || !me.id) return badRequest("Not signed in");
  try {
    const hostId = hostOf(me.id);
    leave(me.id);
    if (hostId != null) {
      emitEvent({ type: "watch.peerLeft", targetUserId: hostId, joinerUsername: me.username });
    }
    return ok({ left: true });
  } catch (err) {
    return serverError(err);
  }
}
