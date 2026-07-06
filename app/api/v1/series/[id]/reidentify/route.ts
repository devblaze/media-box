import type { NextRequest } from "next/server";
import { z } from "zod";
import { reidentifySeries } from "@/server/library/series-service";
import { requireAdmin } from "@/server/auth/guards";
import { badRequest, ok, serverError } from "@/lib/http";

const bodySchema = z.object({ tmdbId: z.number().int().positive() });

export async function POST(request: NextRequest, ctx: RouteContext<"/api/v1/series/[id]/reidentify">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const seriesId = Number(id);
    if (!Number.isInteger(seriesId)) return badRequest("Invalid id");
    const { tmdbId } = bodySchema.parse(await request.json());
    await reidentifySeries(seriesId, tmdbId);
    return ok({ reidentified: true });
  } catch (err) {
    return serverError(err);
  }
}
