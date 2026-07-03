import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { listMovieVersions, listEpisodeVersions } from "@/server/library/versions";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Available quality versions (files) for a movie/episode, for the player picker. */
export async function GET(request: NextRequest) {
  if (!getRequestUser(request)) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const type = request.nextUrl.searchParams.get("type");
  const id = Number(request.nextUrl.searchParams.get("id"));
  if (type !== "movie" && type !== "episode") return badRequest("?type= must be 'movie' or 'episode'");
  if (!Number.isInteger(id) || id <= 0) return badRequest("?id= is required");
  try {
    const versions = type === "movie" ? listMovieVersions(id) : listEpisodeVersions(id);
    return ok({ versions });
  } catch (err) {
    return serverError(err);
  }
}
