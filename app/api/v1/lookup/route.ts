import type { NextRequest } from "next/server";
import { searchMovie, searchTv, posterUrl } from "@/server/metadata/tmdb";
import { badRequest, ok, serverError } from "@/lib/http";

export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get("type");
  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q) return badRequest("Missing ?q=");
  if (type !== "series" && type !== "movie" && type !== "anime") {
    return badRequest("?type= must be 'series', 'movie' or 'anime'");
  }

  try {
    if (type === "series" || type === "anime") {
      const res = await searchTv(q);
      return ok(
        res.results.map((r) => ({
          tmdbId: r.id,
          title: r.name,
          year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) : null,
          overview: r.overview ?? "",
          poster: posterUrl(r.poster_path),
        }))
      );
    }
    const res = await searchMovie(q);
    return ok(
      res.results.map((r) => ({
        tmdbId: r.id,
        title: r.title,
        year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
        overview: r.overview ?? "",
        poster: posterUrl(r.poster_path),
      }))
    );
  } catch (err) {
    return serverError(err);
  }
}
