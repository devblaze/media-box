import type { NextRequest } from "next/server";
import { z } from "zod";
import { getRequestUser } from "@/server/auth/auth-service";
import { emitEvent, type WatchCommand } from "@/server/events/bus";
import { joinersOf } from "@/server/watch-together/session";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const commandSchema: z.ZodType<WatchCommand> = z.object({
  kind: z.enum(["play", "pause", "seek", "title"]),
  positionSeconds: z.number().finite().nonnegative().optional(),
  target: z
    .object({ type: z.enum(["movie", "episode"]), id: z.number().int().positive() })
    .optional(),
});

const bodySchema = z.object({ command: commandSchema });

/**
 * A host broadcasts a transport command (play/pause/seek/title change) to each of
 * their current joiners. Fans out one targeted `watch.sync` event per joiner so
 * the SSE route delivers it only to that joiner's connections.
 */
export async function POST(request: NextRequest) {
  const me = getRequestUser(request);
  if (!me || !me.id) return badRequest("Not signed in");
  try {
    const { command } = bodySchema.parse(await request.json());
    const joiners = joinersOf(me.id);
    for (const joinerId of joiners) {
      emitEvent({ type: "watch.sync", targetUserId: joinerId, command });
    }
    return ok({ delivered: joiners.length });
  } catch (err) {
    return serverError(err);
  }
}
