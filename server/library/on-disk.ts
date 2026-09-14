import path from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { parseTitle, type ParsedRelease } from "@/server/parser/release-parser";
import { getQuality, qualityName, type QualityModel } from "@/server/parser/quality";
import { isUpgrade, type ProfileLike } from "@/server/parser/scoring";
import { normalizeTitle } from "./naming-utils";
import { walkVideoFiles } from "./disk-scanner";

/**
 * "Do we already have this?" — answered from the disk, not from a pointer.
 *
 * Every other caller in media-box asks that question of `episodes.episodeFileId`
 * or `movies.movieFileId`, and those two pointers lie. `setEpisodeOrdering` nulls
 * every episode link for a series and rebuilds it from filenames; the twice-daily
 * RefreshSeries deletes the `episode_files` row of an episode the new ordering no
 * longer covers. Neither goes near the disk, so any file the new numbering can't
 * explain stays exactly where it was with nothing pointing at it. The episode then
 * reads as missing, gets grabbed again, and the second copy lands beside the first
 * under a different name — which is why anime (the only series that get renumbered)
 * end up with two of the same episode in Jellyfin.
 *
 * `integrity.ts` reports that drift; this module is what the acquisition path
 * consults so it stops happening. It is deliberately stateless: a caller that needs
 * the answer for a whole job run builds the map ONCE and reuses it, because each
 * call walks a library folder.
 */

/** A video file found in a library folder, and what its name says it is. */
export interface FileOnDisk {
  absPath: string;
  quality: QualityModel;
}

/**
 * Does this parsed name identify an episode at all? A release has to carry either
 * an absolute number ("Bleach - 409") or exactly one season's SxxExx coordinate
 * before it can be resolved to rows — anything else (a multi-season pack, a bare
 * movie name) maps to nothing.
 */
export function namesAnEpisode(parsed: ParsedRelease): boolean {
  return (
    parsed.isTv &&
    parsed.episodes.length > 0 &&
    (parsed.isAbsolute === true || parsed.seasons.length === 1)
  );
}

/**
 * Resolve a parsed release/filename to this series' episode rows.
 *
 * Factored out of `importer.ts` (which is now its only other caller) so the disk
 * walk below reaches the same episodes an import of the same filename would —
 * including the two anime paths, which is where the numbering actually differs:
 *   - a fansub absolute number with no season at all ("[SubsPlease] Bleach - 409"),
 *     matched through `episodes.absoluteNumber`; and
 *   - an absolute number wearing an SxxExx costume ("Bleach - S01E152" in a show
 *     whose season 1 stops at 63), which is only safe to read as absolute when the
 *     series HAS that season and the number runs past its end.
 */
export function resolveEpisodeRows(
  seriesId: number,
  isAnime: boolean,
  parsed: ParsedRelease
): (typeof schema.episodes.$inferSelect)[] {
  if (!namesAnEpisode(parsed)) return [];
  const db = getDb();
  const isAbsolute = parsed.isAbsolute === true;

  const rows = db
    .select()
    .from(schema.episodes)
    .where(
      isAbsolute
        ? and(
            eq(schema.episodes.seriesId, seriesId),
            inArray(schema.episodes.absoluteNumber, parsed.episodes)
          )
        : and(
            eq(schema.episodes.seriesId, seriesId),
            eq(schema.episodes.seasonNumber, parsed.seasons[0]),
            inArray(schema.episodes.episodeNumber, parsed.episodes)
          )
    )
    .all();
  if (rows.length > 0 || isAbsolute || !isAnime) return rows;

  const inSeason = db
    .select({ n: schema.episodes.episodeNumber })
    .from(schema.episodes)
    .where(
      and(eq(schema.episodes.seriesId, seriesId), eq(schema.episodes.seasonNumber, parsed.seasons[0]))
    )
    .all();
  // An unknown season says nothing about numbering — leave it unmatched.
  if (inSeason.length === 0) return rows;
  const seasonLength = inSeason.reduce((max, r) => Math.max(max, r.n), 0);
  if (!parsed.episodes.every((n) => n > seasonLength)) return rows;
  return db
    .select()
    .from(schema.episodes)
    .where(
      and(
        eq(schema.episodes.seriesId, seriesId),
        inArray(schema.episodes.absoluteNumber, parsed.episodes)
      )
    )
    .all();
}

/**
 * Every episode of this series that has a file sitting in its folder, whatever the
 * database believes. One walk of the series folder; call it once per job run and
 * reuse the map.
 */
export async function episodeFilesOnDisk(seriesId: number): Promise<Map<number, FileOnDisk>> {
  const db = getDb();
  const s = db.select().from(schema.series).where(eq(schema.series.id, seriesId)).get();
  const found = new Map<number, FileOnDisk>();
  if (!s) return found;

  for (const file of await walkVideoFiles(s.path)) {
    const parsed = parseTitle(path.basename(file.absPath));
    const rows = resolveEpisodeRows(seriesId, s.isAnime, parsed);
    for (const row of rows) {
      const seen = found.get(row.id);
      // Two files already claiming one episode is exactly the duplicate this module
      // exists to catch. Keep the better of them so an upgrade decision isn't made
      // against whichever the walk happened to reach first.
      if (
        !seen ||
        getQuality(parsed.quality.qualityId).rank > getQuality(seen.quality.qualityId).rank
      ) {
        found.set(row.id, { absPath: file.absPath, quality: parsed.quality });
      }
    }
  }
  return found;
}

/**
 * Every video file in a movie's folder, best quality first. A movie folder may
 * legitimately hold several files — a 4K next to a 1080p is a deliberate extra
 * version (see `addMovieFileVersion`) — so callers that care about duplicates
 * must compare resolutions themselves rather than assume one file per movie.
 */
export async function movieFilesOnDisk(movieId: number): Promise<FileOnDisk[]> {
  const db = getDb();
  const m = db.select().from(schema.movies).where(eq(schema.movies.id, movieId)).get();
  if (!m) return [];
  // Normally a movie owns its folder, so every video in it is that movie. Library
  // import can attach several movies to one category folder though (that is what
  // `importMovieFileAt` exists for), and there "everything here is mine" would
  // claim the neighbours' files — so in that case the filename has to say so.
  const sharesFolder =
    db
      .select({ id: schema.movies.id })
      .from(schema.movies)
      .where(and(eq(schema.movies.path, m.path), ne(schema.movies.id, m.id)))
      .all().length > 0;
  const files = await walkVideoFiles(m.path);
  return files
    .map((f) => ({
      absPath: f.absPath,
      parsed: parseTitle(path.basename(f.absPath)),
      size: f.size,
    }))
    .filter((f) => !sharesFolder || f.parsed.normalizedTitle === normalizeTitle(m.title))
    .map((f) => ({ absPath: f.absPath, quality: f.parsed.quality, size: f.size }))
    .sort(
      (a, b) =>
        getQuality(b.quality.qualityId).rank - getQuality(a.quality.qualityId).rank ||
        b.size - a.size // same quality tier: the bigger file is the real one (scanMovie agrees)
    )
    .map(({ absPath, quality }) => ({ absPath, quality }));
}

/** The best file in a movie's folder, or null when there is none. */
export async function movieFileOnDisk(movieId: number): Promise<FileOnDisk | null> {
  return (await movieFilesOnDisk(movieId))[0] ?? null;
}

/**
 * Why this grab should be refused because the media is already on disk — or null
 * when nothing stands in its way.
 *
 * Only files the database has LOST are considered: a file it still points at was
 * already weighed by the search evaluation (`currentQuality` in search-targets),
 * and for movies a pointed-at file at another resolution is a wanted version, not
 * a duplicate. A genuine upgrade over the stray file is always allowed through —
 * the import replaces it rather than adding to it.
 */
export async function existingFileBlockingGrab(
  target: { mediaType: "series" | "movie"; movieId?: number; episodeIds?: number[] },
  profile: ProfileLike,
  quality: QualityModel
): Promise<string | null> {
  const db = getDb();

  if (target.mediaType === "movie") {
    if (!target.movieId) return null;
    const m = db.select().from(schema.movies).where(eq(schema.movies.id, target.movieId)).get();
    if (!m || m.movieFileId) return null;
    const onDisk = await movieFileOnDisk(target.movieId);
    if (!onDisk || isUpgrade(profile, quality, onDisk.quality)) return null;
    return (
      `“${path.basename(onDisk.absPath)}” (${qualityName(onDisk.quality)}) is already on disk for ` +
      `${m.title} and this release isn't an upgrade over it. Tick Override to grab it anyway.`
    );
  }

  const episodeIds = target.episodeIds ?? [];
  if (episodeIds.length === 0) return null;
  const episodes = db
    .select()
    .from(schema.episodes)
    .where(inArray(schema.episodes.id, episodeIds))
    .all();
  if (episodes.length === 0) return null;
  const s = db
    .select()
    .from(schema.series)
    .where(eq(schema.series.id, episodes[0].seriesId))
    .get();
  if (!s) return null;

  const missing = episodes.filter((e) => e.episodeFileId == null);
  if (missing.length === 0) return null; // fully linked — the usual upgrade rules apply
  const disk = await episodeFilesOnDisk(s.id);
  const strays = missing.filter((e) => disk.has(e.id));
  // A season pack that fills even one genuinely missing episode is worth grabbing,
  // whatever else is already lying around.
  if (strays.length < missing.length) return null;
  if (strays.some((e) => isUpgrade(profile, quality, disk.get(e.id)!.quality))) return null;

  const first = disk.get(strays[0].id)!;
  const code = (e: { seasonNumber: number; episodeNumber: number }) =>
    `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}`;
  const where =
    strays.length === 1
      ? `${s.title} ${code(strays[0])}`
      : `all ${strays.length} episodes this release covers`;
  return (
    `“${path.basename(first.absPath)}” (${qualityName(first.quality)}) is already on disk for ` +
    `${where} and this release isn't an upgrade over it. Tick Override to grab it anyway.`
  );
}
