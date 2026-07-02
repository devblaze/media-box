import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/guards";
import { addMovie } from "@/server/library/movie-service";
import { addSeries } from "@/server/library/series-service";
import { scanMovie, scanSeries } from "@/server/library/disk-scanner";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const importSchema = z.object({
  type: z.enum(["movie", "series"]),
  path: z.string().min(1),
  tmdbId: z.number().int().positive(),
  rootFolderId: z.number().int().positive(),
  qualityProfileId: z.number().int().positive(),
  monitored: z.boolean().optional(),
});

/**
 * Import an existing on-disk folder into the library: create the movie/series at
 * its current path (no move), then register the files already there so it shows
 * as available immediately.
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let input: z.infer<typeof importSchema>;
  try {
    input = importSchema.parse(await request.json());
  } catch {
    return badRequest("Invalid request body");
  }

  try {
    if (input.type === "movie") {
      const movie = await addMovie({
        tmdbId: input.tmdbId,
        rootFolderId: input.rootFolderId,
        qualityProfileId: input.qualityProfileId,
        monitored: input.monitored ?? true,
        path: input.path,
      });
      const files = await scanMovie(movie.id);
      return ok({ id: movie.id, mediaType: "movie" as const, files }, { status: 201 });
    }

    const series = await addSeries({
      tmdbId: input.tmdbId,
      rootFolderId: input.rootFolderId,
      qualityProfileId: input.qualityProfileId,
      monitored: input.monitored ?? true,
      path: input.path,
    });
    const files = await scanSeries(series.id);
    return ok({ id: series.id, mediaType: "series" as const, files }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && /already in the library/i.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return serverError(err);
  }
}
