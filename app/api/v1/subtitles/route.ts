import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import {
  listSubtitleTracks,
  listEmbeddedSubtitleTracks,
  syncDiskSubtitles,
  wantedLanguages,
} from "@/server/subtitles/subtitle-service";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ffprobe language tags come as ISO 639-2 (3-letter); the app's wanted list uses
// 639-1 (2-letter). Cover both so embedded-track labels read nicely either way.
const LANG_NAMES: Record<string, string> = {
  en: "English",
  eng: "English",
  es: "Spanish",
  spa: "Spanish",
  fr: "French",
  fre: "French",
  fra: "French",
  de: "German",
  ger: "German",
  deu: "German",
  it: "Italian",
  ita: "Italian",
  pt: "Portuguese",
  por: "Portuguese",
  nl: "Dutch",
  dut: "Dutch",
  nld: "Dutch",
  ja: "Japanese",
  jpn: "Japanese",
  ko: "Korean",
  kor: "Korean",
  zh: "Chinese",
  chi: "Chinese",
  zho: "Chinese",
  ru: "Russian",
  rus: "Russian",
  ar: "Arabic",
  ara: "Arabic",
  el: "Greek",
  gre: "Greek",
  ell: "Greek",
};

function langLabel(code: string | null): string {
  if (!code || code === "und") return "Unknown";
  return LANG_NAMES[code.toLowerCase()] ?? code.toUpperCase();
}

/**
 * Subtitle tracks available for a movie/episode, for the player:
 *  - downloaded sidecars, and
 *  - text-based streams embedded in the video itself (extracted to VTT on demand).
 * Also returns the wanted languages + whether this user may search providers live,
 * so the CC menu can offer an on-demand "Search online" action.
 */
export async function GET(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const movieId = Number(request.nextUrl.searchParams.get("movieId")) || undefined;
  const episodeId = Number(request.nextUrl.searchParams.get("episodeId")) || undefined;
  if (!movieId && !episodeId) return badRequest("?movieId= or ?episodeId= is required");
  const key = movieId ? "movieId" : "episodeId";
  const id = movieId ?? episodeId!;
  try {
    // Pick up subtitle files already sitting on disk (sidecars / Subs subfolders).
    await syncDiskSubtitles({ movieId, episodeId });

    const external = listSubtitleTracks({ movieId, episodeId }).map((t) => ({
      id: `ext-${t.id}`,
      kind: "external" as const,
      language: t.language,
      label: langLabel(t.language) + (t.hearingImpaired ? " (SDH)" : ""),
      url: `/api/v1/subtitles/${t.id}/vtt`,
    }));

    const embedded = (
      await listEmbeddedSubtitleTracks({ kind: movieId ? "movie" : "episode", id })
    ).map((e) => ({
      id: `emb-${e.index}`,
      kind: "embedded" as const,
      language: e.language ?? "und",
      label: `${langLabel(e.language)} (embedded)`,
      url: `/api/v1/subtitles/embedded/vtt?${key}=${id}&index=${e.index}`,
    }));

    return ok({
      tracks: [...external, ...embedded],
      languages: wantedLanguages(),
      canSearchOnline: user.role === "admin",
    });
  } catch (err) {
    return serverError(err);
  }
}
