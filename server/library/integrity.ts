import fs from "node:fs";
import path from "node:path";
import { eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { walkVideoFiles } from "./disk-scanner";

/**
 * Does the library the database describes match the library on disk?
 *
 * Every "do we already have this?" decision in media-box — whether to grab a
 * release, whether an import is an upgrade, whether a title is available to
 * watch — reads a single pointer: `movies.movieFileId` or
 * `episodes.episodeFileId`. Nothing stats the disk. So the two can drift apart
 * in both directions, and each direction breaks something different:
 *
 * - **A pointer with no file** makes playback 404 and a title claim to be
 *   available when it isn't.
 * - **A file with no pointer** makes the episode read as missing, so it gets
 *   grabbed and downloaded again, landing beside the copy that was already
 *   there under a different name. That is where duplicates come from.
 *
 * This module is the check neither side had.
 */

export interface BrokenLink {
  kind: "movie" | "episode";
  /** Movie or episode id. */
  id: number;
  title: string;
  /** Where the database says the file is. */
  absPath: string;
}

export interface OrphanFile {
  absPath: string;
  sizeBytes: number;
  /** The library title whose folder it was found under. */
  belongsTo: string;
}

export interface IntegrityReport {
  checkedAt: string;
  movies: { linked: number; missing: BrokenLink[] };
  episodes: { linked: number; missing: BrokenLink[] };
  /** Video files sitting in a library folder that no database row points at. */
  orphans: OrphanFile[];
  /** True when the orphan sweep was skipped or hit its cap. */
  orphansPartial: boolean;
}

/** Cap the lists so one broken library can't produce a megabyte of JSON. */
const MAX_REPORTED = 500;

function exists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Compare every file pointer against the disk, and optionally sweep the library
 * folders for files nothing points at.
 *
 * Read-only: it reports, it never moves, deletes or re-links anything. Deciding
 * what to do about a mismatch needs a human, because the same symptom can mean
 * "the file was deleted outside media-box" or "an ordering change dropped the
 * link and the file is still perfectly good".
 */
export async function checkLibraryIntegrity(
  opts: { includeOrphans?: boolean } = {}
): Promise<IntegrityReport> {
  const db = getDb();
  const report: IntegrityReport = {
    checkedAt: new Date().toISOString(),
    movies: { linked: 0, missing: [] },
    episodes: { linked: 0, missing: [] },
    orphans: [],
    orphansPartial: !opts.includeOrphans,
  };

  // --- movies: pointer -> disk ---
  const movieRows = db
    .select({
      id: schema.movies.id,
      title: schema.movies.title,
      year: schema.movies.year,
      moviePath: schema.movies.path,
      relativePath: schema.movieFiles.relativePath,
    })
    .from(schema.movies)
    .innerJoin(schema.movieFiles, eq(schema.movies.movieFileId, schema.movieFiles.id))
    .where(isNotNull(schema.movies.movieFileId))
    .all();
  for (const row of movieRows) {
    report.movies.linked++;
    const absPath = path.join(row.moviePath, row.relativePath);
    if (!exists(absPath) && report.movies.missing.length < MAX_REPORTED) {
      report.movies.missing.push({
        kind: "movie",
        id: row.id,
        title: row.year ? `${row.title} (${row.year})` : row.title,
        absPath,
      });
    }
  }

  // --- episodes: pointer -> disk ---
  const episodeRows = db
    .select({
      id: schema.episodes.id,
      seasonNumber: schema.episodes.seasonNumber,
      episodeNumber: schema.episodes.episodeNumber,
      seriesTitle: schema.series.title,
      seriesPath: schema.series.path,
      relativePath: schema.episodeFiles.relativePath,
    })
    .from(schema.episodes)
    .innerJoin(schema.episodeFiles, eq(schema.episodes.episodeFileId, schema.episodeFiles.id))
    .innerJoin(schema.series, eq(schema.episodes.seriesId, schema.series.id))
    .where(isNotNull(schema.episodes.episodeFileId))
    .all();
  for (const row of episodeRows) {
    report.episodes.linked++;
    const absPath = path.join(row.seriesPath, row.relativePath);
    if (!exists(absPath) && report.episodes.missing.length < MAX_REPORTED) {
      const code = `S${String(row.seasonNumber).padStart(2, "0")}E${String(row.episodeNumber).padStart(2, "0")}`;
      report.episodes.missing.push({
        kind: "episode",
        id: row.id,
        title: `${row.seriesTitle} ${code}`,
        absPath,
      });
    }
  }

  if (!opts.includeOrphans) return report;

  // --- disk -> pointer: files nothing claims ---
  // Built per library folder rather than globally, so the answer names the title
  // the stray file is sitting under, which is what makes it actionable.
  const seriesRows = db
    .select({ id: schema.series.id, title: schema.series.title, seriesPath: schema.series.path })
    .from(schema.series)
    .all();
  for (const series of seriesRows) {
    if (report.orphans.length >= MAX_REPORTED) {
      report.orphansPartial = true;
      break;
    }
    const known = new Set(
      db
        .select({ relativePath: schema.episodeFiles.relativePath })
        .from(schema.episodeFiles)
        .where(eq(schema.episodeFiles.seriesId, series.id))
        .all()
        .map((r) => path.resolve(series.seriesPath, r.relativePath))
    );
    for (const file of await walkVideoFiles(series.seriesPath)) {
      if (known.has(path.resolve(file.absPath))) continue;
      report.orphans.push({
        absPath: file.absPath,
        sizeBytes: file.size,
        belongsTo: series.title,
      });
      if (report.orphans.length >= MAX_REPORTED) {
        report.orphansPartial = true;
        break;
      }
    }
  }

  return report;
}
