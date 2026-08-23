import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { getTvEpisodeGroups } from "@/server/metadata/tmdb";
import { pickTvdbOrderGroup } from "@/server/metadata/episode-order";
import { enqueueCommand } from "@/server/jobs/scheduler";
import { requireAdmin } from "@/server/auth/guards";
import { badRequest, notFound, ok, serverError } from "@/lib/http";

/**
 * The season orderings this series can use: TMDB's aired order (the default) plus
 * every episode group TMDB publishes for it — "TVDB Order", DVD order, story arcs.
 * Long-running anime need this: TMDB airs Bleach as 2 seasons, everyone else
 * (Jellyfin, the folders on disk, release groups) counts 17.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/v1/series/[id]/ordering">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const seriesId = Number(id);
    if (!Number.isInteger(seriesId)) return badRequest("Invalid id");
    const row = getDb().select().from(schema.series).where(eq(schema.series.id, seriesId)).get();
    if (!row) return notFound("Series not found");

    const { results } = await getTvEpisodeGroups(row.tmdbId);
    const groups = results ?? [];
    const recommended = pickTvdbOrderGroup(groups);
    return ok({
      current: row.episodeGroupId ?? null,
      recommendedId: recommended?.id ?? null,
      options: groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description ?? "",
        type: g.type,
        seasonCount: g.group_count,
        episodeCount: g.episode_count,
      })),
    });
  } catch (err) {
    return serverError(err);
  }
}

const bodySchema = z.object({ episodeGroupId: z.string().min(1).nullable() });

/**
 * Switch the series onto another ordering. Renumbering re-matches every episode
 * file, so it runs as a queued command rather than inline in the request.
 */
export async function PUT(request: NextRequest, ctx: RouteContext<"/api/v1/series/[id]/ordering">) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await ctx.params;
    const seriesId = Number(id);
    if (!Number.isInteger(seriesId)) return badRequest("Invalid id");
    const row = getDb().select().from(schema.series).where(eq(schema.series.id, seriesId)).get();
    if (!row) return notFound("Series not found");

    const { episodeGroupId } = bodySchema.parse(await request.json());
    if ((row.episodeGroupId ?? null) === episodeGroupId) return ok({ queued: false, unchanged: true });

    const commandId = enqueueCommand(
      "ChangeEpisodeOrdering",
      { seriesId, episodeGroupId },
      "manual",
      10
    );
    return ok({ queued: commandId !== null, commandId });
  } catch (err) {
    return serverError(err);
  }
}
