import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { addMovie, getMovieIdByTmdb } from "@/server/library/movie-service";
import { addSeries } from "@/server/library/series-service";
import {
  importMovieFileAt,
  scanMovie,
  scanSeries,
  addMovieFileVersion,
} from "@/server/library/disk-scanner";

/**
 * Background batch import for Library Import "Import all".
 *
 * Runs as a scheduler command so it survives the user leaving the page and emits
 * NO per-file toast — only the command's normal queued/started/completed events.
 * It reuses the exact single-import logic (movie → addMovie + importMovieFileAt;
 * series/anime → addSeries + scanSeries) for every confidently-matched, not-yet-
 * imported candidate of the given type, marking each row imported (or storing its
 * error and continuing) so the persisted unmatched list stays accurate.
 */
export async function libraryImportBatchHandler(payload: unknown): Promise<string> {
  const db = getDb();
  const type = (payload as { type?: string } | null)?.type;
  if (type !== "movie" && type !== "series" && type !== "anime") {
    throw new Error("LibraryImportBatch requires payload.type of 'movie' | 'series' | 'anime'");
  }

  const rows = db
    .select()
    .from(schema.scanCandidates)
    .where(
      and(
        eq(schema.scanCandidates.type, type),
        eq(schema.scanCandidates.status, "matched"),
        eq(schema.scanCandidates.imported, false)
      )
    )
    .all();

  let imported = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      if (row.suggestedTmdbId == null) throw new Error("No TMDB match to import");
      if (row.rootFolderId == null || row.qualityProfileId == null) {
        throw new Error("Scan is missing a root folder or quality profile — rescan and retry");
      }

      // A series/anime scan can surface a movie (anime films in an anime root);
      // legacy rows have no mediaKind and fall back to what the type implies.
      const mediaKind = row.mediaKind ?? (type === "movie" ? "movie" : "series");

      if (mediaKind === "movie") {
        // Already in the library? Attach this file as an extra quality version
        // (skips same-quality dupes) rather than failing.
        const existingId = getMovieIdByTmdb(row.suggestedTmdbId);
        if (existingId) {
          if (row.videoPath) await addMovieFileVersion(existingId, row.videoPath);
        } else {
          const movie = await addMovie({
            tmdbId: row.suggestedTmdbId,
            rootFolderId: row.rootFolderId,
            qualityProfileId: row.qualityProfileId,
            monitored: true,
            path: row.path,
          });
          // Register the exact file the scanner identified (many movies share a
          // category folder); otherwise fall back to folder mode.
          if (row.videoPath) await importMovieFileAt(movie.id, row.videoPath);
          else await scanMovie(movie.id);
        }
      } else {
        const series = await addSeries({
          tmdbId: row.suggestedTmdbId,
          rootFolderId: row.rootFolderId,
          qualityProfileId: row.qualityProfileId,
          monitored: true,
          path: row.path,
          isAnime: type === "anime",
        });
        await scanSeries(series.id);
      }

      db.update(schema.scanCandidates)
        .set({ imported: true, error: null })
        .where(eq(schema.scanCandidates.id, row.id))
        .run();
      imported++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // "already in the library" means the title is effectively imported — done, not a failure.
      if (/already in the library/i.test(message)) {
        db.update(schema.scanCandidates)
          .set({ imported: true, error: null })
          .where(eq(schema.scanCandidates.id, row.id))
          .run();
        imported++;
        continue;
      }
      db.update(schema.scanCandidates)
        .set({ error: message })
        .where(eq(schema.scanCandidates.id, row.id))
        .run();
      failed++;
      console.warn(`[library-import-batch] ${row.name} failed:`, message);
    }
  }

  return `imported ${imported} of ${rows.length}, ${failed} failed`;
}
