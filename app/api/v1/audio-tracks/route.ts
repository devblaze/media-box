import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { listAudioTracks } from "@/server/playback/audio-tracks";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Audio tracks for a movie/episode (from ffprobe), so the player can offer an
 * audio-track picker — the fix for multi-audio files (anime JP/EN dubs) whose
 * default/first track is silent or the wrong one. Empty when there's 0/1 track.
 */
export async function GET(request: NextRequest) {
  if (!getRequestUser(request)) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const movieId = Number(request.nextUrl.searchParams.get("movieId")) || undefined;
  const episodeId = Number(request.nextUrl.searchParams.get("episodeId")) || undefined;
  if (!movieId && !episodeId) return badRequest("?movieId= or ?episodeId= is required");
  try {
    return ok(await listAudioTracks({ kind: movieId ? "movie" : "episode", id: movieId ?? episodeId! }));
  } catch (err) {
    return serverError(err);
  }
}
