import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getRequestUser } from "@/server/auth/auth-service";
import { setWatched } from "@/server/playback/watch-progress-service";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const targetSchema = z.object({
  movieId: z.coerce.number().int().positive().optional(),
  episodeId: z.coerce.number().int().positive().optional(),
  seriesId: z.coerce.number().int().positive().optional(),
});

const bodySchema = targetSchema.extend({
  watched: z.boolean(),
  /** Bulk form: mark many targets at once (e.g. Continue Watching multi-select). */
  items: z.array(targetSchema).max(500).optional(),
});

function hasTarget(t: z.infer<typeof targetSchema>): boolean {
  return !!(t.movieId || t.episodeId || t.seriesId);
}

/**
 * Mark watched / unwatched for the current user. Single form: one movie,
 * episode, or whole series in the body. Bulk form: an `items` array of such
 * targets, all set to the same `watched` value.
 */
export async function POST(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!user.id) return ok({ watched: false, count: 0 }); // api-key pseudo-user has no library identity
  try {
    const body = bodySchema.parse(await request.json());
    const targets = body.items ?? [body];
    if (targets.length === 0 || !targets.every(hasTarget)) {
      return badRequest("Each item needs a movieId, episodeId, or seriesId");
    }
    for (const t of targets) {
      setWatched(user.id, { movieId: t.movieId, episodeId: t.episodeId, seriesId: t.seriesId }, body.watched);
    }
    return ok({ watched: body.watched, count: targets.length });
  } catch (err) {
    return serverError(err);
  }
}
