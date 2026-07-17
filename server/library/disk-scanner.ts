import path from "node:path";
import fs from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { parseTitle, parseQuality, parseReleaseGroup } from "@/server/parser/release-parser";
import { getQuality, type QualityModel } from "@/server/parser/quality";
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

/** Lowercase, alphanumeric-only, single-spaced — for loose title comparison. */
function normalizeTitleText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Anime files are usually organized in TVDB broadcast-season folders (Season 02/03…)
 * while TMDB lists the show as one long absolute-numbered season — so an `SxxExx` lookup
 * for a higher season finds no episode. This fallback bridges that by matching the file
 * to a still-unlinked episode whose (distinctive) title is contained in the filename.
 * Returns an episode id only on a single confident match; ambiguous or weak matches are
 * skipped so a wrong link never happens (a missing episode is better than a wrong one).
 */
function matchEpisodeByTitle(
  fileBaseName: string,
  episodes: { id: number; title: string | null }[],
  taken: Set<number>
): number | null {
  const haystack = normalizeTitleText(fileBaseName);
  let matchId: number | null = null;
  for (const ep of episodes) {
    if (taken.has(ep.id) || !ep.title) continue;
    const needle = normalizeTitleText(ep.title);
    if (needle.length < 12) continue; // too short to be a distinctive anchor
    if (haystack.includes(needle)) {
      if (matchId !== null) return null; // two titles match this file → ambiguous, bail
      matchId = ep.id;
    }
  }
  return matchId;
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

  // Anime title-fallback context: the series' episodes (for matching a file to an
  // episode by title when its season folder doesn't line up with the flat metadata)
  // and the set of episodes already linked to a file (never link one twice).
  const seriesEpisodes = s.isAnime
    ? db
        .select({ id: schema.episodes.id, title: schema.episodes.title })
        .from(schema.episodes)
        .where(eq(schema.episodes.seriesId, seriesId))
        .all()
    : [];
  const taken = new Set<number>();
  for (const ep of db
    .select({ id: schema.episodes.id, episodeFileId: schema.episodes.episodeFileId })
    .from(schema.episodes)
    .where(eq(schema.episodes.seriesId, seriesId))
    .all()) {
    if (ep.episodeFileId != null) taken.add(ep.id);
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

    let targetEpisodeIds = episodeRows.map((e) => e.id);
    if (targetEpisodeIds.length === 0) {
      // No SxxExx match. For anime, try to bridge a TVDB season folder to the flat
      // TMDB numbering by matching the episode title inside the filename.
      const byTitle = s.isAnime
        ? matchEpisodeByTitle(path.basename(file.absPath), seriesEpisodes, taken)
        : null;
      if (byTitle === null) continue;
      targetEpisodeIds = [byTitle];
    }

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
    for (const id of targetEpisodeIds) {
      db.update(schema.episodes)
        .set({ episodeFileId: fileRow.id })
        .where(eq(schema.episodes.id, id))
        .run();
      taken.add(id);
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

/**
 * Add a file to an existing movie as an additional quality VERSION (e.g. keep a
 * 4K next to a 1080p) rather than replacing. Skips it when the same file or a file
 * of the same resolution is already present (so you don't end up with duplicates).
 * The highest-resolution version becomes the primary (what plays / shows by default).
 */
export async function addMovieFileVersion(
  movieId: number,
  videoAbsPath: string
): Promise<{ added: boolean; reason?: string }> {
  const db = getDb();
  const m = db.select().from(schema.movies).where(eq(schema.movies.id, movieId)).get();
  if (!m) return { added: false, reason: "movie missing" };

  const name = path.basename(videoAbsPath);
  const quality = parseQuality(name);
  const newRes = getQuality(quality.qualityId).resolution;
  const relativePath = path.relative(m.path, videoAbsPath);

  const existing = db
    .select()
    .from(schema.movieFiles)
    .where(eq(schema.movieFiles.movieId, movieId))
    .all();
  if (existing.some((f) => f.relativePath === relativePath)) {
    return { added: false, reason: "file already imported" };
  }
  if (existing.some((f) => getQuality((f.quality as QualityModel)?.qualityId ?? 0).resolution === newRes)) {
    return { added: false, reason: `a ${newRes || "same"}p version already exists` };
  }

  let size = 0;
  try {
    size = (await fs.stat(videoAbsPath)).size;
  } catch {
    /* register with size 0 rather than fail */
  }
  const fileRow = db
    .insert(schema.movieFiles)
    .values({
      movieId,
      relativePath,
      size,
      quality,
      releaseGroup: parseReleaseGroup(name) ?? null,
      sceneName: path.basename(videoAbsPath, path.extname(videoAbsPath)),
      dateAdded: new Date(),
    })
    .returning({ id: schema.movieFiles.id })
    .get();

  // Promote to primary when there's no primary yet or this version is higher-res.
  const primaryRes = m.movieFileId
    ? getQuality(
        (existing.find((f) => f.id === m.movieFileId)?.quality as QualityModel)?.qualityId ?? 0
      ).resolution
    : -1;
  if (!m.movieFileId || newRes > primaryRes) {
    db.update(schema.movies).set({ movieFileId: fileRow.id }).where(eq(schema.movies.id, movieId)).run();
  }
  emitEvent({ type: "movie.updated", movieId });
  return { added: true };
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
