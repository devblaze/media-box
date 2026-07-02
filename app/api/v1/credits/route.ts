import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { getMovieCredits, getTvAggregateCredits, profileUrl } from "@/server/metadata/tmdb";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cast for a title (actors for movies; aggregate incl. voice actors for series/anime). */
export async function GET(request: NextRequest) {
  if (!getRequestUser(request)) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const type = request.nextUrl.searchParams.get("type");
  const tmdbId = Number(request.nextUrl.searchParams.get("tmdbId"));
  if (type !== "movie" && type !== "series") return badRequest("?type= must be 'movie' or 'series'");
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return badRequest("?tmdbId= is required");

  try {
    const credits =
      type === "movie" ? await getMovieCredits(tmdbId) : await getTvAggregateCredits(tmdbId);
    const cast = (credits.cast ?? []).slice(0, 30).map((c) => ({
      id: c.id,
      name: c.name,
      character: c.character ?? c.roles?.[0]?.character ?? "",
      profile: profileUrl(c.profile_path),
    }));
    return ok({ cast });
  } catch (err) {
    return serverError(err);
  }
}
