import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { getMovieImages, getTvImages, pickLogo } from "@/server/metadata/tmdb";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Best title-logo artwork (transparent PNG) for a TMDB title, used by the hero
 * billboard to render the title's name as its branded logo. Returns { logo: url|null }.
 */
export async function GET(request: NextRequest) {
  if (!getRequestUser(request)) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const type = request.nextUrl.searchParams.get("type");
  const tmdbId = Number(request.nextUrl.searchParams.get("tmdbId"));
  if (type !== "movie" && type !== "series") return badRequest("?type= must be 'movie' or 'series'");
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return badRequest("?tmdbId= is required");

  try {
    const images = type === "movie" ? await getMovieImages(tmdbId) : await getTvImages(tmdbId);
    return ok({ logo: pickLogo(images) });
  } catch (err) {
    return serverError(err);
  }
}
