import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/guards";
import {
  searchSubtitleCandidates,
  downloadSubtitleCandidate,
  type SubtitleTarget,
} from "@/server/subtitles/subtitle-service";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function targetFrom(movieId?: number, episodeId?: number): SubtitleTarget | null {
  if (movieId) return { kind: "movie", id: movieId };
  if (episodeId) return { kind: "episode", id: episodeId };
  return null;
}

/**
 * Interactive subtitle search — candidates for a movie/episode. Accepts a single
 * `language` or a comma-separated `languages` list (searched together, merged).
 */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const sp = request.nextUrl.searchParams;
  const target = targetFrom(
    Number(sp.get("movieId")) || undefined,
    Number(sp.get("episodeId")) || undefined
  );
  const langsParam = sp.get("languages") || sp.get("language");
  if (!target || !langsParam) return badRequest("Provide movieId or episodeId, and language(s)");
  const languages = [...new Set(langsParam.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (languages.length === 0) return badRequest("Provide at least one language");
  try {
    const perLang = await Promise.all(languages.map((l) => searchSubtitleCandidates(target, l)));
    return ok(perLang.flat());
  } catch (err) {
    return serverError(err);
  }
}

const postSchema = z.object({
  movieId: z.coerce.number().int().positive().optional(),
  episodeId: z.coerce.number().int().positive().optional(),
  candidateId: z.string().min(1),
});

/** Download a chosen candidate (by its opaque id from GET) as the sidecar. */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const b = postSchema.parse(await request.json());
    const target = targetFrom(b.movieId, b.episodeId);
    if (!target) return badRequest("Provide movieId or episodeId");
    const downloaded = await downloadSubtitleCandidate(target, b.candidateId);
    if (!downloaded) return badRequest("Candidate expired or failed — search again");
    return ok({ downloaded });
  } catch (err) {
    return serverError(err);
  }
}
