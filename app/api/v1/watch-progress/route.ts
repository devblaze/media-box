import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getRequestUser } from "@/server/auth/auth-service";
import { upsertProgress, getProgress } from "@/server/playback/watch-progress-service";
import { isUserStreaming, userSharesStreaming } from "@/server/users/user-activity-service";
import { emitEvent } from "@/server/events/bus";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const movieId = Number(request.nextUrl.searchParams.get("movieId")) || undefined;
  const episodeId = Number(request.nextUrl.searchParams.get("episodeId")) || undefined;
  if (!movieId && !episodeId) return badRequest("?movieId= or ?episodeId= is required");
  try {
    return ok(getProgress(user.id, { movieId, episodeId }));
  } catch (err) {
    return serverError(err);
  }
}

const putSchema = z.object({
  movieId: z.coerce.number().int().positive().optional(),
  episodeId: z.coerce.number().int().positive().optional(),
  seriesId: z.coerce.number().int().positive().optional(),
  positionSeconds: z.coerce.number().min(0),
  durationSeconds: z.coerce.number().min(0),
});

export async function PUT(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!user.id) return ok({ saved: false }); // api-key pseudo-user has no library identity
  try {
    const body = putSchema.parse(await request.json());
    if (!body.movieId && !body.episodeId) return badRequest("movieId or episodeId is required");
    // Detect the heartbeat that STARTS a streaming window (before the write —
    // afterwards the user always looks like they're streaming).
    const wasStreaming = isUserStreaming(user.id);
    upsertProgress(user.id, {
      movieId: body.movieId ?? null,
      episodeId: body.episodeId ?? null,
      seriesId: body.seriesId ?? null,
      positionSeconds: Math.floor(body.positionSeconds),
      durationSeconds: Math.floor(body.durationSeconds),
    });
    if (!wasStreaming && userSharesStreaming(user.id)) {
      emitEvent({ type: "watch.streamsChanged" });
    }
    return ok({ saved: true });
  } catch (err) {
    return serverError(err);
  }
}
