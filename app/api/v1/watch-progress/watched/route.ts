import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getRequestUser } from "@/server/auth/auth-service";
import { setWatched } from "@/server/playback/watch-progress-service";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  movieId: z.coerce.number().int().positive().optional(),
  episodeId: z.coerce.number().int().positive().optional(),
  seriesId: z.coerce.number().int().positive().optional(),
  watched: z.boolean(),
});

/** Mark a movie, episode, or whole series watched / unwatched for the current user. */
export async function POST(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!user.id) return ok({ watched: false }); // api-key pseudo-user has no library identity
  try {
    const body = bodySchema.parse(await request.json());
    if (!body.movieId && !body.episodeId && !body.seriesId) {
      return badRequest("movieId, episodeId, or seriesId is required");
    }
    setWatched(
      user.id,
      { movieId: body.movieId, episodeId: body.episodeId, seriesId: body.seriesId },
      body.watched
    );
    return ok({ watched: body.watched });
  } catch (err) {
    return serverError(err);
  }
}
