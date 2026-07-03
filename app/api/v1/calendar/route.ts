import type { NextRequest } from "next/server";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upcoming (and recent) air dates for episodes of monitored series/anime — feeds
 * the public schedule calendar. `?start=`/`?end=` (ISO) bound the window; default
 * is a ~6-week window from today. Any signed-in user may read it.
 */
export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const sp = request.nextUrl.searchParams;
    const start = sp.get("start") ? new Date(sp.get("start")!) : new Date();
    const end = sp.get("end")
      ? new Date(sp.get("end")!)
      : new Date(start.getTime() + 42 * 86_400_000);

    const rows = db
      .select({
        episodeId: schema.episodes.id,
        seriesId: schema.series.id,
        seriesTitle: schema.series.title,
        posterPath: schema.series.posterPath,
        isAnime: schema.series.isAnime,
        seasonNumber: schema.episodes.seasonNumber,
        episodeNumber: schema.episodes.episodeNumber,
        episodeTitle: schema.episodes.title,
        airDateUtc: schema.episodes.airDateUtc,
        episodeFileId: schema.episodes.episodeFileId,
      })
      .from(schema.episodes)
      .innerJoin(schema.series, eq(schema.episodes.seriesId, schema.series.id))
      .where(
        and(
          eq(schema.episodes.monitored, true),
          eq(schema.series.monitored, true),
          gte(schema.episodes.airDateUtc, start),
          lte(schema.episodes.airDateUtc, end)
        )
      )
      .orderBy(asc(schema.episodes.airDateUtc))
      .all();

    return ok(
      rows.map(({ episodeFileId, ...r }) => ({ ...r, hasFile: episodeFileId != null }))
    );
  } catch (err) {
    return serverError(err);
  }
}
