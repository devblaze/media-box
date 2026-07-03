import type { NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { searchMovie, searchTv, posterUrl } from "@/server/metadata/tmdb";
import { getRequestUser } from "@/server/auth/auth-service";
import { getDb, schema } from "@/server/db";
import {
  annotateAvailability,
  availabilityKey,
  type MediaKind,
} from "@/server/metadata/availability";
import { badRequest, ok, serverError } from "@/lib/http";

export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get("type");
  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q) return badRequest("Missing ?q=");
  if (type !== "series" && type !== "movie" && type !== "anime") {
    return badRequest("?type= must be 'series', 'movie' or 'anime'");
  }

  // Anime is looked up as TV and stored as a series request.
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

    // Attach library/global request availability so the UI can flag titles that
    // are already available or requested (by anyone) before offering "Request".
    const avail = annotateAvailability(
      base.map((b) => ({ tmdbId: b.tmdbId, mediaType: mediaKind }))
    );

    // Which of these the signed-in caller has personally requested already.
    const requestedByMe = new Set<number>();
    const user = getRequestUser(request);
    if (user && user.id !== 0 && base.length > 0) {
      const db = getDb();
      const mine = db
        .select({ tmdbId: schema.requests.tmdbId })
        .from(schema.requests)
        .where(
          and(
            eq(schema.requests.userId, user.id),
            eq(schema.requests.mediaType, mediaKind),
            inArray(
              schema.requests.tmdbId,
              base.map((b) => b.tmdbId)
            )
          )
        )
        .all();
      for (const r of mine) requestedByMe.add(r.tmdbId);
    }

    return ok(
      base.map((b) => ({
        ...b,
        status: avail.get(availabilityKey(mediaKind, b.tmdbId))?.status ?? "unavailable",
        requestedByMe: requestedByMe.has(b.tmdbId),
      }))
    );
  } catch (err) {
    return serverError(err);
  }
}
