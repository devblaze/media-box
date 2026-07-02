import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/guards";
import { addMovie } from "@/server/library/movie-service";
import { addSeries } from "@/server/library/series-service";
import { scanMovie, scanSeries, importMovieFileAt } from "@/server/library/disk-scanner";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const importSchema = z.object({
  type: z.enum(["movie", "series", "anime"]),
  path: z.string().min(1),
  /** Absolute path of the specific movie file to register (movies only). */
  videoPath: z.string().optional(),
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
      // Register the exact file when the scanner identified one (many movies can
      // share a category folder); otherwise fall back to folder mode.
      const files = input.videoPath
        ? await importMovieFileAt(movie.id, input.videoPath)
        : await scanMovie(movie.id);
      return ok({ id: movie.id, mediaType: "movie" as const, files }, { status: 201 });
    }

    const series = await addSeries({
      tmdbId: input.tmdbId,
      rootFolderId: input.rootFolderId,
      qualityProfileId: input.qualityProfileId,
      monitored: input.monitored ?? true,
      path: input.path,
      isAnime: input.type === "anime",
    });
    const files = await scanSeries(series.id);
    return ok({ id: series.id, mediaType: input.type, files }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && /already in the library/i.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return serverError(err);
  }
}
