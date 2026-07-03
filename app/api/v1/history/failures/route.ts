import type { NextRequest } from "next/server";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { requireAdmin } from "@/server/auth/guards";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Failed download/grab/import attempts (history `downloadFailed`) for the admin
 * failures calendar. `?start=`/`?end=` (ISO) bound the window; default is the last
 * 60 days. Each row carries what the UI needs to rebuild an interactive-search
 * scope: `movieId`, or `episodeId`, or `seriesId + season` (from `data`). Admin only.
 */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const db = getDb();
    const sp = request.nextUrl.searchParams;
    const end = sp.get("end") ? new Date(sp.get("end")!) : new Date();
    const start = sp.get("start")
      ? new Date(sp.get("start")!)
      : new Date(end.getTime() - 60 * 86_400_000);

    const rows = db
      .select({
        id: schema.history.id,
        date: schema.history.date,
        mediaType: schema.history.mediaType,
        seriesId: schema.history.seriesId,
        movieId: schema.history.movieId,
        episodeId: schema.history.episodeId,
        seriesTitle: schema.series.title,
        movieTitle: schema.movies.title,
        sourceTitle: schema.history.sourceTitle,
        quality: schema.history.quality,
        data: schema.history.data,
      })
      .from(schema.history)
      .leftJoin(schema.series, eq(schema.history.seriesId, schema.series.id))
      .leftJoin(schema.movies, eq(schema.history.movieId, schema.movies.id))
      .where(
        and(
          eq(schema.history.eventType, "downloadFailed"),
          gte(schema.history.date, start),
          lte(schema.history.date, end)
        )
      )
      .orderBy(desc(schema.history.date))
      .all();

    return ok(rows);
  } catch (err) {
    return serverError(err);
  }
}
