import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";

export type MediaType = "movie" | "episode";

export interface ResolvedMedia {
  /** Absolute on-disk path, built from DB rows only (never from user input). */
  absPath: string;
  /** Human-friendly label for logs / the transcode session. */
  title: string;
}

/**
 * Resolve a movie/episode id to its absolute on-disk path + a display title.
 *
 * The path is always composed from trusted DB columns (`movie.path` +
 * `movieFile.relativePath`, or `series.path` + `episodeFile.relativePath`) so a
 * caller can never coerce an arbitrary filesystem path. Returns `null` when the
 * id is invalid, the row is missing, or there is no associated file.
 *
 * Shared by the direct-stream routes and the transcode pipeline.
 */
export function resolveMediaPath(type: MediaType, id: number): ResolvedMedia | null {
  if (!Number.isInteger(id)) return null;
  const db = getDb();

  if (type === "movie") {
    const movie = db.select().from(schema.movies).where(eq(schema.movies.id, id)).get();
    if (!movie || !movie.movieFileId) return null;
    const file = db
      .select()
      .from(schema.movieFiles)
      .where(eq(schema.movieFiles.id, movie.movieFileId))
      .get();
    if (!file) return null;
    return {
      absPath: path.join(movie.path, file.relativePath),
      title: movie.year ? `${movie.title} (${movie.year})` : movie.title,
    };
  }

  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, id)).get();
  if (!episode || !episode.episodeFileId) return null;
  const file = db
    .select()
    .from(schema.episodeFiles)
    .where(eq(schema.episodeFiles.id, episode.episodeFileId))
    .get();
  if (!file) return null;
  const series = db.select().from(schema.series).where(eq(schema.series.id, episode.seriesId)).get();
  if (!series) return null;
  const code = `S${String(episode.seasonNumber).padStart(2, "0")}E${String(
    episode.episodeNumber
  ).padStart(2, "0")}`;
  return {
    absPath: path.join(series.path, file.relativePath),
    title: `${series.title} ${code}`,
  };
}
