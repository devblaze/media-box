import path from "node:path";
import fs from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { parseTitle, parseQuality, parseReleaseGroup } from "@/server/parser/release-parser";
import { emitEvent } from "@/server/events/bus";

export const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".m4v", ".ts", ".wmv"]);
const MIN_VIDEO_SIZE = 50 * 1024 * 1024; // ignore samples/extras under 50 MB

export async function walkVideoFiles(root: string): Promise<{ absPath: string; size: number }[]> {
  const results: { absPath: string; size: number }[] = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return results; // folder missing/unreadable — skip quietly, health check reports separately
  }
  for (const entry of entries) {
    const absPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkVideoFiles(absPath)));
    } else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      if (/\bsample\b/i.test(entry.name)) continue;
      const stat = await fs.stat(absPath);
      if (stat.size >= MIN_VIDEO_SIZE) results.push({ absPath, size: stat.size });
    }
  }
  return results;
}

export async function scanSeries(seriesId: number): Promise<number> {
  const db = getDb();
  const s = db.select().from(schema.series).where(eq(schema.series.id, seriesId)).get();
  if (!s) return 0;

  const files = await walkVideoFiles(s.path);
  const knownFiles = db
    .select()
    .from(schema.episodeFiles)
    .where(eq(schema.episodeFiles.seriesId, seriesId))
    .all();
  const knownByPath = new Map(knownFiles.map((f) => [f.relativePath, f]));

  // prune records whose file vanished
  const presentRelPaths = new Set(files.map((f) => path.relative(s.path, f.absPath)));
  for (const known of knownFiles) {
    if (!presentRelPaths.has(known.relativePath)) {
      db.delete(schema.episodeFiles).where(eq(schema.episodeFiles.id, known.id)).run();
    }
  }

  let added = 0;
  for (const file of files) {
    const relativePath = path.relative(s.path, file.absPath);
    if (knownByPath.has(relativePath)) continue;

    const parsed = parseTitle(path.basename(file.absPath));
    if (!parsed.isTv || parsed.seasons.length !== 1 || parsed.episodes.length === 0) continue;

    const seasonNumber = parsed.seasons[0];
    const episodeRows = db
      .select()
      .from(schema.episodes)
      .where(
        and(
          eq(schema.episodes.seriesId, seriesId),
          eq(schema.episodes.seasonNumber, seasonNumber),
          inArray(schema.episodes.episodeNumber, parsed.episodes)
        )
      )
      .all();
    if (episodeRows.length === 0) continue;

    const fileRow = db
      .insert(schema.episodeFiles)
      .values({
        seriesId,
        relativePath,
        size: file.size,
        quality: parsed.quality,
        releaseGroup: parsed.releaseGroup ?? null,
        sceneName: path.basename(file.absPath, path.extname(file.absPath)),
        dateAdded: new Date(),
      })
      .returning({ id: schema.episodeFiles.id })
      .get();
    for (const ep of episodeRows) {
      db.update(schema.episodes)
        .set({ episodeFileId: fileRow.id })
        .where(eq(schema.episodes.id, ep.id))
        .run();
    }
    added++;
  }
  emitEvent({ type: "series.updated", seriesId });
  return added;
}

export async function scanMovie(movieId: number): Promise<number> {
  const db = getDb();
  const m = db.select().from(schema.movies).where(eq(schema.movies.id, movieId)).get();
  if (!m) return 0;

  const files = await walkVideoFiles(m.path);
  const existing = m.movieFileId
    ? db.select().from(schema.movieFiles).where(eq(schema.movieFiles.id, m.movieFileId)).get()
    : null;

  if (existing) {
    const stillThere = files.some((f) => path.relative(m.path, f.absPath) === existing.relativePath);
    if (!stillThere) {
      db.update(schema.movies).set({ movieFileId: null }).where(eq(schema.movies.id, movieId)).run();
      db.delete(schema.movieFiles).where(eq(schema.movieFiles.id, existing.id)).run();
    } else {
      return 0;
    }
  }

  // largest video file wins
  const best = files.sort((a, b) => b.size - a.size)[0];
  if (!best) {
    emitEvent({ type: "movie.updated", movieId });
    return 0;
  }

  const name = path.basename(best.absPath);
  const fileRow = db
    .insert(schema.movieFiles)
    .values({
      movieId,
      relativePath: path.relative(m.path, best.absPath),
      size: best.size,
      quality: parseQuality(name),
      releaseGroup: parseReleaseGroup(name) ?? null,
      sceneName: path.basename(best.absPath, path.extname(best.absPath)),
      dateAdded: new Date(),
    })
    .returning({ id: schema.movieFiles.id })
    .get();
  db.update(schema.movies).set({ movieFileId: fileRow.id }).where(eq(schema.movies.id, movieId)).run();
  emitEvent({ type: "movie.updated", movieId });
  return 1;
}

/**
 * Register one SPECIFIC video file as a movie's file (used by library import when
 * many movies share a category folder, so `scanMovie`'s "largest file in folder"
 * heuristic would pick the wrong one). Replaces any existing movieFile.
 */
export async function importMovieFileAt(movieId: number, videoAbsPath: string): Promise<number> {
  const db = getDb();
  const m = db.select().from(schema.movies).where(eq(schema.movies.id, movieId)).get();
  if (!m) return 0;

  // Drop any previously-registered file for this movie.
  if (m.movieFileId) {
    db.update(schema.movies).set({ movieFileId: null }).where(eq(schema.movies.id, movieId)).run();
    db.delete(schema.movieFiles).where(eq(schema.movieFiles.id, m.movieFileId)).run();
  }

  let size = 0;
  try {
    size = (await fs.stat(videoAbsPath)).size;
  } catch {
    // File missing/unreadable — register with size 0 rather than fail the import.
  }

  const name = path.basename(videoAbsPath);
  const fileRow = db
    .insert(schema.movieFiles)
    .values({
      movieId,
      relativePath: path.relative(m.path, videoAbsPath),
      size,
      quality: parseQuality(name),
      releaseGroup: parseReleaseGroup(name) ?? null,
      sceneName: path.basename(videoAbsPath, path.extname(videoAbsPath)),
      dateAdded: new Date(),
    })
    .returning({ id: schema.movieFiles.id })
    .get();
  db.update(schema.movies).set({ movieFileId: fileRow.id }).where(eq(schema.movies.id, movieId)).run();
  emitEvent({ type: "movie.updated", movieId });
  return 1;
}

export async function scanAll(): Promise<string> {
  const db = getDb();
  const allSeries = db.select({ id: schema.series.id }).from(schema.series).all();
  const allMovies = db.select({ id: schema.movies.id }).from(schema.movies).all();
  let added = 0;
  for (const s of allSeries) added += await scanSeries(s.id);
  for (const m of allMovies) added += await scanMovie(m.id);
  return `scanned ${allSeries.length} series, ${allMovies.length} movies; ${added} new files`;
}
