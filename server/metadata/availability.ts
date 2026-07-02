import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";

export type MediaKind = "movie" | "series";

/**
 * Availability of a TMDB title relative to this media-box library:
 *  - available   : in the library AND has downloaded file(s) — playable now.
 *  - requested   : in the library but still downloading, OR has a pending/approved request.
 *  - unavailable : neither in the library nor requested.
 */
export type AvailabilityStatus = "available" | "requested" | "unavailable";

export interface Availability {
  status: AvailabilityStatus;
  /** Library id (movies.id / series.id) when the title is in the library, else null. */
  mediaId: number | null;
}

export function availabilityKey(mediaType: MediaKind, tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}

/**
 * Batch-resolve library availability for a set of TMDB titles in a few queries.
 * Returns a map keyed by `availabilityKey(mediaType, tmdbId)`.
 */
export function annotateAvailability(
  items: { tmdbId: number; mediaType: MediaKind }[]
): Map<string, Availability> {
  const out = new Map<string, Availability>();
  if (items.length === 0) return out;

  const db = getDb();
  const movieTmdbIds = [...new Set(items.filter((i) => i.mediaType === "movie").map((i) => i.tmdbId))];
  const seriesTmdbIds = [...new Set(items.filter((i) => i.mediaType === "series").map((i) => i.tmdbId))];

  // --- library movies (with/without a downloaded file) ---
  const movieRows = movieTmdbIds.length
    ? db
        .select({
          tmdbId: schema.movies.tmdbId,
          id: schema.movies.id,
          movieFileId: schema.movies.movieFileId,
        })
        .from(schema.movies)
        .where(inArray(schema.movies.tmdbId, movieTmdbIds))
        .all()
    : [];
  const movieByTmdb = new Map(movieRows.map((r) => [r.tmdbId, r]));

  // --- library series + which of them have any episode file ---
  const seriesRows = seriesTmdbIds.length
    ? db
        .select({ tmdbId: schema.series.tmdbId, id: schema.series.id })
        .from(schema.series)
        .where(inArray(schema.series.tmdbId, seriesTmdbIds))
        .all()
    : [];
  const seriesByTmdb = new Map(seriesRows.map((r) => [r.tmdbId, r]));
  const seriesLibIds = seriesRows.map((r) => r.id);
  const seriesWithFiles = new Set<number>();
  if (seriesLibIds.length) {
    const fileRows = db
      .select({ seriesId: schema.episodeFiles.seriesId })
      .from(schema.episodeFiles)
      .where(inArray(schema.episodeFiles.seriesId, seriesLibIds))
      .all();
    for (const r of fileRows) seriesWithFiles.add(r.seriesId);
  }

  // --- pending/approved requests for any of these titles ---
  const allTmdbIds = [...movieTmdbIds, ...seriesTmdbIds];
  const requested = new Set<string>();
  if (allTmdbIds.length) {
    const reqRows = db
      .select({
        mediaType: schema.requests.mediaType,
        tmdbId: schema.requests.tmdbId,
        status: schema.requests.status,
      })
      .from(schema.requests)
      .where(inArray(schema.requests.tmdbId, allTmdbIds))
      .all();
    for (const r of reqRows) {
      if (r.status === "pending" || r.status === "approved") {
        requested.add(availabilityKey(r.mediaType as MediaKind, r.tmdbId));
      }
    }
  }

  for (const item of items) {
    const key = availabilityKey(item.mediaType, item.tmdbId);
    if (out.has(key)) continue;

    if (item.mediaType === "movie") {
      const lib = movieByTmdb.get(item.tmdbId);
      if (lib?.movieFileId != null) out.set(key, { status: "available", mediaId: lib.id });
      else if (lib) out.set(key, { status: "requested", mediaId: lib.id });
      else if (requested.has(key)) out.set(key, { status: "requested", mediaId: null });
      else out.set(key, { status: "unavailable", mediaId: null });
    } else {
      const lib = seriesByTmdb.get(item.tmdbId);
      if (lib && seriesWithFiles.has(lib.id)) out.set(key, { status: "available", mediaId: lib.id });
      else if (lib) out.set(key, { status: "requested", mediaId: lib.id });
      else if (requested.has(key)) out.set(key, { status: "requested", mediaId: null });
      else out.set(key, { status: "unavailable", mediaId: null });
    }
  }

  return out;
}
