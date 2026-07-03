import type { NextRequest } from "next/server";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { ok, badRequest, notFound, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Neighbor {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  seriesTitle: string;
}

/**
 * The previous / next PLAYABLE episode (one that has a file) relative to this
 * episode, ordered by season then episode across season boundaries. Feeds the
 * player's Prev/Next buttons + auto-advance "up next". Any signed-in user.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/v1/episodes/[id]/neighbors">) {
  const { id } = await ctx.params;
  const epId = Number(id);
  if (!Number.isInteger(epId)) return badRequest("Invalid id");
  try {
    const db = getDb();
    const cur = db
      .select({ seriesId: schema.episodes.seriesId })
      .from(schema.episodes)
      .where(eq(schema.episodes.id, epId))
      .get();
    if (!cur) return notFound("Episode not found");

    const seriesTitle =
      db
        .select({ title: schema.series.title })
        .from(schema.series)
        .where(eq(schema.series.id, cur.seriesId))
        .get()?.title ?? "";

    const list = db
      .select({
        id: schema.episodes.id,
        seasonNumber: schema.episodes.seasonNumber,
        episodeNumber: schema.episodes.episodeNumber,
        title: schema.episodes.title,
      })
      .from(schema.episodes)
      .where(and(eq(schema.episodes.seriesId, cur.seriesId), isNotNull(schema.episodes.episodeFileId)))
      .orderBy(asc(schema.episodes.seasonNumber), asc(schema.episodes.episodeNumber))
      .all();

    const idx = list.findIndex((e) => e.id === epId);
    const toNeighbor = (e: (typeof list)[number] | undefined): Neighbor | null =>
      e ? { ...e, seriesTitle } : null;

    return ok({
      prev: idx > 0 ? toNeighbor(list[idx - 1]) : null,
      next: idx >= 0 && idx < list.length - 1 ? toNeighbor(list[idx + 1]) : null,
    });
  } catch (err) {
    return serverError(err);
  }
}
