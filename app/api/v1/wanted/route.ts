import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { ok, serverError } from "@/lib/http";

export async function GET() {
  try {
    const db = getDb();
    const now = new Date();

    const missingEpisodes = db
      .select({
        episodeId: schema.episodes.id,
        seriesId: schema.series.id,
        seriesTitle: schema.series.title,
        seasonNumber: schema.episodes.seasonNumber,
        episodeNumber: schema.episodes.episodeNumber,
        episodeTitle: schema.episodes.title,
        airDateUtc: schema.episodes.airDateUtc,
      })
      .from(schema.episodes)
      .innerJoin(schema.series, eq(schema.episodes.seriesId, schema.series.id))
      .where(
        and(
          eq(schema.episodes.monitored, true),
          isNull(schema.episodes.episodeFileId),
          eq(schema.series.monitored, true),
          lt(schema.episodes.airDateUtc, now)
        )
      )
      .orderBy(desc(schema.episodes.airDateUtc))
      .limit(200)
      .all();

    const missingMovies = db
      .select({
        movieId: schema.movies.id,
        title: schema.movies.title,
        year: schema.movies.year,
        status: schema.movies.status,
        minimumAvailability: schema.movies.minimumAvailability,
      })
      .from(schema.movies)
      .where(and(eq(schema.movies.monitored, true), isNull(schema.movies.movieFileId)))
      .orderBy(desc(schema.movies.addedAt))
      .limit(200)
      .all();

    return ok({ episodes: missingEpisodes, movies: missingMovies });
  } catch (err) {
    return serverError(err);
  }
}
