import type { NextRequest } from "next/server";
import { z } from "zod";
import { reidentifyMovie } from "@/server/library/movie-service";
import { requireAdmin } from "@/server/auth/guards";
import { badRequest, ok, serverError } from "@/lib/http";

const bodySchema = z.object({ tmdbId: z.number().int().positive() });

export async function POST(request: NextRequest, ctx: RouteContext<"/api/v1/movies/[id]/reidentify">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const movieId = Number(id);
    if (!Number.isInteger(movieId)) return badRequest("Invalid id");
    const { tmdbId } = bodySchema.parse(await request.json());
    await reidentifyMovie(movieId, tmdbId);
    return ok({ reidentified: true });
  } catch (err) {
    return serverError(err);
  }
}
