import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getRequestUser } from "@/server/auth/auth-service";
import { resolveMediaPath } from "@/server/library/resolve-media";
import { badRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const EXTRACT_TIMEOUT_MS = 90_000;
const EXTRACT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Extract a text-based embedded subtitle stream from a movie/episode file and
 * serve it as WebVTT for the in-app player. `index` is 0-based among the file's
 * subtitle streams (as returned by `listEmbeddedSubtitleTracks`), mapped straight
 * to ffmpeg's `0:s:index`. The path is resolved from DB rows only, never user
 * input, and image-based codecs are filtered out upstream so `-f webvtt` succeeds.
 */
export async function GET(request: NextRequest) {
  if (!getRequestUser(request)) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const movieId = Number(sp.get("movieId")) || undefined;
  const episodeId = Number(sp.get("episodeId")) || undefined;
  const rawIndex = sp.get("index");
  const index = rawIndex === null ? NaN : Number(rawIndex);
  if ((!movieId && !episodeId) || !Number.isInteger(index) || index < 0) {
    return badRequest("Provide movieId or episodeId, and a non-negative index");
  }

  const resolved = resolveMediaPath(movieId ? "movie" : "episode", movieId ?? episodeId!);
  if (!resolved) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const { stdout } = await execFileAsync(
      "ffmpeg",
      ["-v", "quiet", "-nostdin", "-i", resolved.absPath, "-map", `0:s:${index}`, "-f", "webvtt", "-"],
      { timeout: EXTRACT_TIMEOUT_MS, maxBuffer: EXTRACT_MAX_BUFFER, encoding: "utf8" }
    );
    if (!stdout || !stdout.includes("WEBVTT")) {
      return NextResponse.json({ error: "No extractable subtitle at that index" }, { status: 404 });
    }
    return new NextResponse(stdout, {
      headers: {
        "Content-Type": "text/vtt; charset=utf-8",
        // Extraction is expensive; let the browser cache the result for the session.
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    // ffmpeg missing (ENOENT), timeout, or an image-based stream that slipped through.
    return NextResponse.json({ error: "Could not extract subtitle" }, { status: 404 });
  }
}
