import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { listSubtitleTracks } from "@/server/subtitles/subtitle-service";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LANG_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  ru: "Russian",
  ar: "Arabic",
  el: "Greek",
};

/** Downloaded subtitle tracks (sidecars) available for a movie/episode, for the player. */
export async function GET(request: NextRequest) {
  if (!getRequestUser(request)) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const movieId = Number(request.nextUrl.searchParams.get("movieId")) || undefined;
  const episodeId = Number(request.nextUrl.searchParams.get("episodeId")) || undefined;
  if (!movieId && !episodeId) return badRequest("?movieId= or ?episodeId= is required");
  try {
    const tracks = listSubtitleTracks({ movieId, episodeId }).map((t) => ({
      id: t.id,
      language: t.language,
      label:
        (LANG_NAMES[t.language] ?? t.language.toUpperCase()) + (t.hearingImpaired ? " (SDH)" : ""),
      url: `/api/v1/subtitles/${t.id}/vtt`,
    }));
    return ok({ tracks });
  } catch (err) {
    return serverError(err);
  }
}
