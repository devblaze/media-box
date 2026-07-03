import type { NextRequest } from "next/server";
import { searchMovie, searchTv, posterUrl } from "@/server/metadata/tmdb";
import {
  annotateAvailability,
  availabilityKey,
  type MediaKind,
} from "@/server/metadata/availability";
import { badRequest, ok, serverError } from "@/lib/http";

/**
 * TMDB search for the request flow, annotated with library availability so the UI
 * can avoid offering "Request" for titles we already have — or that someone (any
 * user) has already requested. Anime is searched as TV and tracked as a series.
 */
export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get("type");
  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q) return badRequest("Missing ?q=");
  if (type !== "series" && type !== "movie" && type !== "anime") {
    return badRequest("?type= must be 'series', 'movie' or 'anime'");
  }
  const mediaKind: MediaKind = type === "movie" ? "movie" : "series";

  try {
    const base =
      mediaKind === "movie"
        ? (await searchMovie(q)).results.map((r) => ({
            tmdbId: r.id,
            title: r.title,
            year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
            overview: r.overview ?? "",
            poster: posterUrl(r.poster_path),
            posterPath: r.poster_path ?? null,
          }))
        : (await searchTv(q)).results.map((r) => ({
            tmdbId: r.id,
            title: r.name,
            year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) : null,
            overview: r.overview ?? "",
            poster: posterUrl(r.poster_path),
            posterPath: r.poster_path ?? null,
          }));

    const avail = annotateAvailability(base.map((b) => ({ tmdbId: b.tmdbId, mediaType: mediaKind })));
    const out = base.map((b) => {
      const a = avail.get(availabilityKey(mediaKind, b.tmdbId));
      return { ...b, status: a?.status ?? "unavailable", mediaId: a?.mediaId ?? null };
    });
    return ok(out);
  } catch (err) {
    return serverError(err);
  }
}
