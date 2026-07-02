import type { NextRequest } from "next/server";
import { z } from "zod";
import { searchReleases } from "@/server/indexers/release-search";
import { episodeTarget, movieTarget, seasonTarget } from "@/server/indexers/search-targets";
import { grab } from "@/server/download/download-service";
import { badRequest, ok, serverError } from "@/lib/http";

function targetFromParams(params: URLSearchParams, interactive: boolean) {
  const episodeId = params.get("episodeId");
  const movieId = params.get("movieId");
  const seriesId = params.get("seriesId");
  const season = params.get("season");
  if (episodeId) return episodeTarget(Number(episodeId), interactive);
  if (movieId) return movieTarget(Number(movieId), interactive);
  if (seriesId && season !== null) return seasonTarget(Number(seriesId), Number(season), interactive);
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const target = targetFromParams(request.nextUrl.searchParams, true);
    if (!target) return badRequest("Provide ?episodeId=, ?movieId=, or ?seriesId=&season=");
    const releases = await searchReleases(target.search);
    return ok(releases);
  } catch (err) {
    return serverError(err);
  }
}

const grabSchema = z.object({
  guid: z.string(),
  episodeId: z.number().int().optional(),
  movieId: z.number().int().optional(),
  seriesId: z.number().int().optional(),
  season: z.number().int().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = grabSchema.parse(await request.json());
    const params = new URLSearchParams();
    if (body.episodeId) params.set("episodeId", String(body.episodeId));
    if (body.movieId) params.set("movieId", String(body.movieId));
    if (body.seriesId !== undefined && body.season !== undefined) {
      params.set("seriesId", String(body.seriesId));
      params.set("season", String(body.season));
    }
    const target = targetFromParams(params, true);
    if (!target) return badRequest("Provide episodeId, movieId, or seriesId+season");

    // re-search and locate the chosen release by guid (results are not cached server-side)
    const releases = await searchReleases(target.search);
    const release = releases.find((r) => r.guid === body.guid);
    if (!release) return badRequest("Release no longer available — search again");

    const download = await grab(release, target.grab);
    return ok(download, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
