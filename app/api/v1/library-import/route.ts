import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/server/auth/guards";
import { addMovie, getMovieIdByTmdb } from "@/server/library/movie-service";
import { addSeries } from "@/server/library/series-service";
import {
  scanMovie,
  scanSeries,
  importMovieFileAt,
  addMovieFileVersion,
} from "@/server/library/disk-scanner";
import { markCandidateImported } from "@/server/library/library-import";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const importSchema = z.object({
  type: z.enum(["movie", "series", "anime"]),
  // What the candidate actually is — a series/anime scan can surface a movie
  // (anime films in an anime root). Defaults to what `type` implies.
  mediaKind: z.enum(["movie", "series"]).optional(),
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
  const denied = requirePermission(request, "libraryImport.access");
  if (denied) return denied;

  let input: z.infer<typeof importSchema>;
  try {
    input = importSchema.parse(await request.json());
  } catch {
    return badRequest("Invalid request body");
  }

  const mediaKind = input.mediaKind ?? (input.type === "movie" ? "movie" : "series");

  try {
    if (mediaKind === "movie") {
      // Already in the library? Add this file as an extra quality VERSION (e.g. a 4K
      // next to a 1080p) instead of rejecting — same-quality files are skipped.
      const existingId = getMovieIdByTmdb(input.tmdbId);
      if (existingId) {
        markCandidateImported(input.type, input.path);
        if (!input.videoPath) {
          return NextResponse.json({ error: "Movie is already in the library" }, { status: 409 });
        }
        const version = await addMovieFileVersion(existingId, input.videoPath);
        return ok({ id: existingId, mediaType: "movie" as const, version }, { status: 200 });
      }
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
      // Drop this title from any persisted scan so it stays gone after navigation.
      markCandidateImported(input.type, input.path);
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
    markCandidateImported(input.type, input.path);
    return ok({ id: series.id, mediaType: input.type, files }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && /already in the library/i.test(err.message)) {
      // Already present → also treat as imported for the persisted scan.
      markCandidateImported(input.type, input.path);
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return serverError(err);
  }
}
