import type { NextRequest } from "next/server";
import { z } from "zod";
import { getRequestUser } from "@/server/auth/auth-service";
import { emitEvent } from "@/server/events/bus";
import { join } from "@/server/watch-together/session";
import { getShareableStreams } from "@/server/users/user-activity-service";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ hostUserId: z.number().int().positive() });

/**
 * Join a host's stream to watch together in sync. The host must have "Share
 * streaming activity" on AND be streaming right now; we register the joiner,
 * toast the host ("… joined your stream"), and return the host's current title
 * so the caller can open the player pointed at it.
 */
export async function POST(request: NextRequest) {
  const me = getRequestUser(request);
  if (!me || !me.id) return badRequest("Not signed in");
  try {
    const { hostUserId } = bodySchema.parse(await request.json());
    if (hostUserId === me.id) return badRequest("You can't join your own stream");

    // The host must be sharing AND actively streaming (so we have a target).
    const host = getShareableStreams().find((s) => s.userId === hostUserId);
    if (!host) return badRequest("That user isn't sharing a stream right now");

    const { stream } = host;
    const id = stream.kind === "movie" ? stream.movieId : stream.episodeId;
    if (id == null) return badRequest("The host's stream can't be joined");

    join(hostUserId, me.id);
    emitEvent({ type: "watch.peerJoined", targetUserId: hostUserId, joinerUsername: me.username });

    return ok({
      hostUserId,
      hostUsername: host.username,
      target: { type: stream.kind, id },
      title: stream.title,
      positionSeconds: stream.positionSeconds,
    });
  } catch (err) {
    return serverError(err);
  }
}
