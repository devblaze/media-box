import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { addMovie, getMovieIdByTmdb } from "./movie-service";
import { addSeries } from "./series-service";
import { coordinatesOnDisk, orderingForImport } from "./ordering-audit";
import { addMovieFileVersion, importMovieFileAt, scanMovie, scanSeries } from "./disk-scanner";
import type { ImportType, MediaKind } from "./library-import";

/** A title found on disk and identified, ready to become (or join) a library entry. */
export interface AdoptCandidate {
  mediaKind: MediaKind;
  /** The library section it was found in: decides the anime flag for a series. */
  type: ImportType;
  tmdbId: number;
  /** The title's folder (a movie's may be a shared category folder). */
  path: string;
  /** Movies: the exact file the scan identified. */
  videoPath: string | null;
  rootFolderId: number;
  qualityProfileId: number;
  /**
   * Whether media-box should go looking for what's missing. An import the admin
   * asks for monitors; one media-box makes on its own must not start downloads.
   */
  monitored: boolean;
}

export type AdoptOutcome =
  /** New library entry. */
  | "added"
  /** Already in the library with nothing on disk: pointed at these files. */
  | "relinked"
  /** Already in the library: this file joined it as another version. */
  | "version"
  /** Already in the library with its files: nothing to do. */
  | "present";

/**
 * Bring one identified on-disk title into the library — the single import path
 * for Library Import's "Import all" and the automatic library sync.
 *
 * A title already in the library whose files were never found (an entry made
 * from a request, a migration from a box where paths differed) is repointed at
 * the folder that actually holds it, so it stops showing as missing.
 */
export async function adoptCandidate(c: AdoptCandidate): Promise<AdoptOutcome> {
  const db = getDb();

  if (c.mediaKind === "movie") {
    const existingId = getMovieIdByTmdb(c.tmdbId);
    if (existingId) {
      const movie = db
        .select({ movieFileId: schema.movies.movieFileId })
        .from(schema.movies)
        .where(eq(schema.movies.id, existingId))
        .get();
      if (movie?.movieFileId == null) {
        db.update(schema.movies)
          .set({ path: c.path })
          .where(eq(schema.movies.id, existingId))
          .run();
        if (c.videoPath) await importMovieFileAt(existingId, c.videoPath);
        else await scanMovie(existingId);
        return "relinked";
      }
      // Has a file already: keep this one as an extra quality version (skips
      // same-quality duplicates).
      if (c.videoPath) {
        const { added } = await addMovieFileVersion(existingId, c.videoPath);
        if (added) return "version";
      }
      return "present";
    }
    const movie = await addMovie({
      tmdbId: c.tmdbId,
      rootFolderId: c.rootFolderId,
      qualityProfileId: c.qualityProfileId,
      monitored: c.monitored,
      path: c.path,
    });
    // Register the exact file the scanner identified (many movies share a
    // category folder); otherwise fall back to folder mode.
    if (c.videoPath) await importMovieFileAt(movie.id, c.videoPath);
    else await scanMovie(movie.id);
    return "added";
  }

  const existing = db
    .select({ id: schema.series.id })
    .from(schema.series)
    .where(eq(schema.series.tmdbId, c.tmdbId))
    .get();
  if (existing) {
    const linked = db
      .select({ id: schema.episodeFiles.id })
      .from(schema.episodeFiles)
      .where(eq(schema.episodeFiles.seriesId, existing.id))
      .get();
    if (linked) return "present";
    db.update(schema.series).set({ path: c.path }).where(eq(schema.series.id, existing.id)).run();
    await scanSeries(existing.id);
    return "relinked";
  }

  // The folder was sorted by whatever the user ran before (Sonarr, Jellyfin,
  // Plex) — all of which count TVDB seasons. Pin the ordering that explains the
  // numbering already on disk BEFORE scanning, so every file matches the first
  // time instead of landing on a same-numbered episode of the wrong arc.
  const observed = await coordinatesOnDisk(c.path);
  const episodeGroupId = await orderingForImport(c.tmdbId, observed);
  const series = await addSeries({
    tmdbId: c.tmdbId,
    rootFolderId: c.rootFolderId,
    qualityProfileId: c.qualityProfileId,
    monitored: c.monitored,
    monitorMode: c.monitored ? undefined : "none",
    path: c.path,
    isAnime: c.type === "anime",
    // undefined = let addSeries decide (anime default); a hit overrides it.
    episodeGroupId: episodeGroupId ?? undefined,
  });
  await scanSeries(series.id);
  return "added";
}
