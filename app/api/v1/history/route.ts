import type { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { ok, serverError } from "@/lib/http";

export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 100), 500);
    const rows = db
      .select({
        id: schema.history.id,
        eventType: schema.history.eventType,
        mediaType: schema.history.mediaType,
        sourceTitle: schema.history.sourceTitle,
        quality: schema.history.quality,
        date: schema.history.date,
        seriesId: schema.history.seriesId,
        movieId: schema.history.movieId,
        seriesTitle: schema.series.title,
        movieTitle: schema.movies.title,
        data: schema.history.data,
      })
      .from(schema.history)
      .leftJoin(schema.series, eq(schema.series.id, schema.history.seriesId))
      .leftJoin(schema.movies, eq(schema.movies.id, schema.history.movieId))
      .orderBy(desc(schema.history.date))
      .limit(limit)
      .all();
    return ok(rows);
  } catch (err) {
    return serverError(err);
  }
}
