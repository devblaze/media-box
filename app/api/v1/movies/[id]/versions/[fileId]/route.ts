import type { NextRequest } from "next/server";
import { requireAdmin } from "@/server/auth/guards";
import { deleteMovieVersion } from "@/server/library/movie-service";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Delete one quality version of a movie (admin). `?deleteFile=true` also removes it from disk. */
export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/v1/movies/[id]/versions/[fileId]">
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id, fileId } = await ctx.params;
  const movieId = Number(id);
  const fid = Number(fileId);
  if (!Number.isInteger(movieId) || !Number.isInteger(fid)) return badRequest("Invalid id");
  const deleteFile = request.nextUrl.searchParams.get("deleteFile") === "true";
  try {
    return ok(await deleteMovieVersion(movieId, fid, deleteFile));
  } catch (err) {
    return serverError(err);
  }
}
