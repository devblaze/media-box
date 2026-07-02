import { getDb, schema } from "@/server/db";

export interface ResetCounts {
  watchProgress: number;
  subtitleFiles: number;
  episodeFiles: number;
  episodes: number;
  seasons: number;
  movieFiles: number;
  movies: number;
  series: number;
}

/**
 * Wipe every library entry from the database — movies, series, and everything
 * hanging off them — so the user can re-run library import from scratch.
 *
 * DB-ONLY: this makes ZERO filesystem calls. Nothing on disk is touched; the
 * files stay exactly where they are and can be re-imported. Deletes run in
 * FK-safe order (children before parents) via drizzle `delete`.
 */
export function resetLibrary(): ResetCounts {
  const db = getDb();
  const del = (table: Parameters<typeof db.delete>[0]): number => db.delete(table).run().changes;

  const watchProgress = del(schema.watchProgress);
  const subtitleFiles = del(schema.subtitleFiles);
  const episodeFiles = del(schema.episodeFiles);
  const episodes = del(schema.episodes);
  const seasons = del(schema.seasons);
  const movieFiles = del(schema.movieFiles);
  const movies = del(schema.movies);
  const series = del(schema.series);

  return { watchProgress, subtitleFiles, episodeFiles, episodes, seasons, movieFiles, movies, series };
}
