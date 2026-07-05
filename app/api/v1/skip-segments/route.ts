import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { skipSegments } from "@/server/playback/skip-segments";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Skippable intro/recap segments for a movie/episode (from chapter markers), so
 * the player can offer "Skip Intro" / "Skip Recap" buttons. Empty when the file
 * has no named chapters.
 */
export async function GET(request: NextRequest) {
  if (!getRequestUser(request)) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const movieId = Number(request.nextUrl.searchParams.get("movieId")) || undefined;
  const episodeId = Number(request.nextUrl.searchParams.get("episodeId")) || undefined;
  if (!movieId && !episodeId) return badRequest("?movieId= or ?episodeId= is required");
  try {
    return ok(await skipSegments({ kind: movieId ? "movie" : "episode", id: movieId ?? episodeId! }));
  } catch (err) {
    return serverError(err);
  }
}
