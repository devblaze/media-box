import path from "node:path";
import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getMovie } from "@/server/metadata/tmdb";
import { mapMovie } from "@/server/metadata/tmdb-map";
import { renderMovieFolder } from "./naming";
import { emitEvent } from "@/server/events/bus";

export interface AddMovieInput {
  tmdbId: number;
  rootFolderId: number;
  qualityProfileId: number;
  monitored?: boolean;
  minimumAvailability?: "announced" | "inCinemas" | "released";
  /** Import an existing on-disk folder in place instead of deriving the path from the naming template. */
  path?: string;
}

/** The library id of a movie already imported for this TMDB id, if any. */
export function getMovieIdByTmdb(tmdbId: number): number | undefined {
  return getDb()
    .select({ id: schema.movies.id })
    .from(schema.movies)
    .where(eq(schema.movies.tmdbId, tmdbId))
    .get()?.id;
}

export async function addMovie(input: AddMovieInput) {
  const db = getDb();

  const existing = db
    .select({ id: schema.movies.id })
    .from(schema.movies)
    .where(eq(schema.movies.tmdbId, input.tmdbId))
    .get();
  if (existing) throw new Error("Movie is already in the library");

  const rootFolder = db
    .select()
    .from(schema.rootFolders)
    .where(eq(schema.rootFolders.id, input.rootFolderId))
    .get();
  if (!rootFolder) throw new Error("Root folder not found");

  const details = await getMovie(input.tmdbId);
  const mapped = mapMovie(details);
  const naming = db.select().from(schema.namingConfig).get();
  const template = naming?.movieFolderFormat?.trim() || "{Movie Title} ({Year})";
  const folderName = renderMovieFolder(template, { title: mapped.title, year: mapped.year });
  const moviePath = input.path ?? path.join(rootFolder.path, folderName);

  const row = db
    .insert(schema.movies)
    .values({
      ...mapped,
      path: moviePath,
      rootFolderId: rootFolder.id,
      qualityProfileId: input.qualityProfileId,
      monitored: input.monitored ?? true,
      minimumAvailability: input.minimumAvailability ?? "released",
      addedAt: new Date(),
      lastRefreshAt: new Date(),
    })
    .returning()
    .get();

  await fs.mkdir(moviePath, { recursive: true });
  emitEvent({ type: "movie.updated", movieId: row.id });
  return row;
}

export async function refreshMovie(movieId: number) {
  const db = getDb();
  const row = db.select().from(schema.movies).where(eq(schema.movies.id, movieId)).get();
  if (!row) throw new Error(`Movie ${movieId} not found`);
  const details = await getMovie(row.tmdbId);
  const mapped = mapMovie(details);
  db.update(schema.movies)
    .set({ ...mapped, lastRefreshAt: new Date() })
    .where(eq(schema.movies.id, movieId))
    .run();
  emitEvent({ type: "movie.updated", movieId });
}

export async function deleteMovie(movieId: number, deleteFiles: boolean) {
  const db = getDb();
  const row = db.select().from(schema.movies).where(eq(schema.movies.id, movieId)).get();
  if (!row) return;
  db.delete(schema.movies).where(eq(schema.movies.id, movieId)).run();
  if (deleteFiles) {
    await fs.rm(row.path, { recursive: true, force: true });
  }
  emitEvent({ type: "movie.updated", movieId });
}

/**
 * Delete one quality VERSION (movie_file) of a movie — its DB row and, when
 * `deleteFile`, its file on disk. If it was the primary, the largest remaining
 * version becomes the new primary (or none).
 */
export async function deleteMovieVersion(
  movieId: number,
  fileId: number,
  deleteFile: boolean
): Promise<{ deleted: boolean }> {
  const db = getDb();
  const movie = db.select().from(schema.movies).where(eq(schema.movies.id, movieId)).get();
  if (!movie) return { deleted: false };
  const file = db
    .select()
    .from(schema.movieFiles)
    .where(and(eq(schema.movieFiles.id, fileId), eq(schema.movieFiles.movieId, movieId)))
    .get();
  if (!file) return { deleted: false };

  db.delete(schema.movieFiles).where(eq(schema.movieFiles.id, fileId)).run();

  // Re-point the primary if we just deleted it (largest remaining version wins).
  if (movie.movieFileId === fileId) {
    const remaining = db
      .select()
      .from(schema.movieFiles)
      .where(eq(schema.movieFiles.movieId, movieId))
      .all()
      .sort((a, b) => b.size - a.size);
    db.update(schema.movies)
      .set({ movieFileId: remaining[0]?.id ?? null })
      .where(eq(schema.movies.id, movieId))
      .run();
  }

  if (deleteFile) {
    try {
      await fs.rm(path.join(movie.path, file.relativePath), { force: true });
    } catch {
      /* file already gone — ignore */
    }
  }
  emitEvent({ type: "movie.updated", movieId });
  return { deleted: true };
}
