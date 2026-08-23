import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { parseTitle } from "@/server/parser/release-parser";
import { getTv } from "@/server/metadata/tmdb";
import {
  bestOrdering,
  scoreOrderings,
  type ObservedCoordinate,
  type OrderingScore,
  type SeasonSummary,
} from "@/server/metadata/episode-order";
import { recordLog } from "@/server/logging/logger";
import { setEpisodeOrdering } from "./series-service";
import { walkVideoFiles } from "./disk-scanner";

/**
 * Season numbering drifts between sources. TMDB airs a long-running anime as one
 * huge season; Sonarr, Jellyfin and Plex all count TVDB's arc-based seasons; the
 * files on disk carry whichever numbering the tool that sorted them used. A
 * library moved over from Sonarr therefore arrives full of `Season 07/…S07E20`
 * files for shows media-box believes only have two seasons — every one of them
 * matched to the wrong episode, or to none.
 *
 * This module reads the numbering the library ITSELF uses and re-points each
 * series at the TMDB ordering that explains it (see `series.episodeGroupId`).
 */

/** One series whose files disagree with the ordering it is numbered by. */
export interface OrderingFinding {
  seriesId: number;
  title: string;
  isAnime: boolean;
  currentGroupId: string | null;
  /** Episode files whose own name was compared against the episode they link to. */
  filesChecked: number;
  /** …of which point at a different episode than the one they are linked to. */
  mismatched: number;
  /** Season numbers the files use that the series doesn't have at all. */
  unknownSeasons: number[];
  reason: string;
}

/** What an alignment run did to one series. */
export interface OrderingChange {
  seriesId: number;
  title: string;
  from: string | null;
  to: string | null;
  toName: string;
  coverage: number;
  /** Observed coordinates the new ordering explains, out of `observed`. */
  covered: number;
  observed: number;
}

/**
 * Read `SxxExx` (or an absolute number) out of a library-relative file path.
 * The file name wins; a `Season 07/` parent supplies the season when the name
 * alone only carries an episode number.
 */
export function coordinateOfPath(relativePath: string): {
  seasonNumber: number | null;
  episodeNumbers: number[];
  isAbsolute: boolean;
} {
  const parsed = parseTitle(path.basename(relativePath));
  if (!parsed.isTv || parsed.episodes.length === 0) {
    return { seasonNumber: null, episodeNumbers: [], isAbsolute: false };
  }
  if (parsed.seasons.length === 1) {
    return {
      seasonNumber: parsed.seasons[0],
      episodeNumbers: parsed.episodes,
      isAbsolute: false,
    };
  }
  const folder = path.dirname(relativePath).match(/(?:^|[/\\])(?:season|series)[ ._-]*(\d{1,3})$/i);
  return {
    seasonNumber: folder ? parseInt(folder[1], 10) : null,
    episodeNumbers: parsed.episodes,
    isAbsolute: parsed.isAbsolute === true,
  };
}

/**
 * Series whose recorded files are numbered differently from the episodes they
 * are attached to. Pure DB work — no TMDB, no disk — so the UI can show the
 * damage immediately and let the user decide whether to fix it.
 */
export function auditLibraryOrdering(seriesIds?: number[]): OrderingFinding[] {
  const db = getDb();
  const allSeries = db
    .select()
    .from(schema.series)
    .all()
    .filter((s) => !seriesIds || seriesIds.includes(s.id));

  const findings: OrderingFinding[] = [];
  for (const s of allSeries) {
    const episodes = db
      .select()
      .from(schema.episodes)
      .where(eq(schema.episodes.seriesId, s.id))
      .all();
    if (episodes.length === 0) continue;
    const files = db
      .select()
      .from(schema.episodeFiles)
      .where(eq(schema.episodeFiles.seriesId, s.id))
      .all();
    if (files.length === 0) continue;

    const episodeByFile = new Map<number, (typeof episodes)[number]>();
    for (const ep of episodes) if (ep.episodeFileId != null) episodeByFile.set(ep.episodeFileId, ep);
    const knownSeasons = new Set(episodes.map((e) => e.seasonNumber));

    let filesChecked = 0;
    let mismatched = 0;
    const unknownSeasons = new Set<number>();
    for (const f of files) {
      const ep = episodeByFile.get(f.id);
      if (!ep) continue;
      const c = coordinateOfPath(f.relativePath);
      if (c.episodeNumbers.length === 0) continue;
      filesChecked++;
      if (c.isAbsolute || c.seasonNumber === null) {
        // Absolute numbering says nothing about seasons; it is only wrong when it
        // disagrees with the absolute number we hold for that episode.
        if (ep.absoluteNumber != null && !c.episodeNumbers.includes(ep.absoluteNumber)) mismatched++;
        continue;
      }
      if (!knownSeasons.has(c.seasonNumber)) unknownSeasons.add(c.seasonNumber);
      if (c.seasonNumber !== ep.seasonNumber || !c.episodeNumbers.includes(ep.episodeNumber)) {
        mismatched++;
      }
    }

    if (mismatched === 0) continue;
    findings.push({
      seriesId: s.id,
      title: s.title,
      isAnime: s.isAnime,
      currentGroupId: s.episodeGroupId ?? null,
      filesChecked,
      mismatched,
      unknownSeasons: [...unknownSeasons].sort((a, b) => a - b),
      reason:
        unknownSeasons.size > 0
          ? `Files use season${unknownSeasons.size === 1 ? "" : "s"} ${[...unknownSeasons]
              .sort((a, b) => a - b)
              .join(", ")}, which this series doesn't have`
          : `${mismatched} of ${filesChecked} files are numbered differently from the episode they're on`,
    });
  }
  return findings.sort((a, b) => b.mismatched - a.mismatched);
}

/**
 * Every season/episode coordinate the series' own files use — the recorded ones
 * plus whatever else is sitting in its folder (a file that matched nothing is
 * exactly the evidence we're after, and it has no DB row).
 */
async function observedCoordinates(seriesPath: string): Promise<ObservedCoordinate[]> {
  const out: ObservedCoordinate[] = [];
  for (const file of await walkVideoFiles(seriesPath)) {
    const c = coordinateOfPath(path.relative(seriesPath, file.absPath));
    if (c.isAbsolute || c.seasonNumber === null) continue; // no season to judge
    for (const e of c.episodeNumbers) out.push({ seasonNumber: c.seasonNumber, episodeNumber: e });
  }
  return out;
}

/**
 * Score one series' own files against the candidate orderings and report the one
 * that explains them better than the current pick. Null when the current
 * ordering already fits, or when there isn't enough evidence to justify a
 * renumber. No writes — `alignSeriesOrdering` does that part.
 */
export async function previewSeriesOrdering(seriesId: number): Promise<OrderingChange | null> {
  const db = getDb();
  const s = db.select().from(schema.series).where(eq(schema.series.id, seriesId)).get();
  if (!s) throw new Error(`Series ${seriesId} not found`);

  const observed = await observedCoordinates(s.path);
  if (observed.length === 0) return null;

  const details = await getTv(s.tmdbId);
  const scores = await scoreOrderings(s.tmdbId, details.seasons, observed);
  const winner = bestOrdering(scores, s.episodeGroupId ?? null);
  if (!winner) return null;

  return {
    seriesId,
    title: s.title,
    from: s.episodeGroupId ?? null,
    to: winner.id,
    toName: winner.name,
    coverage: winner.coverage,
    covered: winner.covered,
    observed: observed.length,
  };
}

/** `previewSeriesOrdering`, then actually renumber the series and re-match its files. */
export async function alignSeriesOrdering(seriesId: number): Promise<OrderingChange | null> {
  const change = await previewSeriesOrdering(seriesId);
  if (!change) return null;
  await setEpisodeOrdering(seriesId, change.to);
  recordLog(
    "info",
    `[ordering] “${change.title}” re-numbered onto ${change.toName} — it explains ${change.covered}/${change.observed} of the episode files`,
    { source: "ordering", context: change }
  );
  return change;
}

/**
 * Walk the library and align every series whose files say the numbering is wrong.
 *
 * `dryRun` scores without changing anything, which is what the "what would this
 * do?" preview uses. Series are visited newest-mismatch-first so a partial run
 * (a restart, a TMDB outage) still fixes the worst offenders.
 */
export async function alignLibraryOrdering(
  opts: { seriesIds?: number[]; dryRun?: boolean } = {}
): Promise<{ changes: OrderingChange[]; checked: number; failed: number }> {
  const db = getDb();
  let candidates = opts.seriesIds;
  if (!candidates) {
    // No explicit list: everything the cheap audit flagged, plus anime nobody has
    // pinned yet — their files may simply have matched nothing at all, which the
    // audit can't see because an unmatched file has no row to compare.
    const unpinnedAnime = db
      .select({
        id: schema.series.id,
        isAnime: schema.series.isAnime,
        episodeGroupId: schema.series.episodeGroupId,
      })
      .from(schema.series)
      .all()
      .filter((row) => row.isAnime && (row.episodeGroupId ?? null) === null)
      .map((row) => row.id);
    candidates = [...new Set([...auditLibraryOrdering().map((f) => f.seriesId), ...unpinnedAnime])];
  }

  const changes: OrderingChange[] = [];
  let checked = 0;
  let failed = 0;
  for (const seriesId of candidates) {
    checked++;
    try {
      if (opts.dryRun) {
        const preview = await previewSeriesOrdering(seriesId);
        if (preview) changes.push(preview);
      } else {
        const change = await alignSeriesOrdering(seriesId);
        if (change) changes.push(change);
      }
    } catch (err) {
      failed++;
      console.warn(`[ordering] series ${seriesId} could not be aligned:`, err);
    }
  }
  return { changes, checked, failed };
}

/**
 * Pick the ordering for a series being brought in from a source that counts
 * seasons its own way — a Sonarr migration (TVDB) or an existing Jellyfin/Plex
 * folder tree. Returns null to keep TMDB's aired order.
 *
 * This runs before the series has any episodes, so the evidence is whatever the
 * source told us: the season/episode coordinates it uses.
 */
export async function orderingForImport(
  tmdbId: number,
  observed: ObservedCoordinate[],
  seasonSummaries?: SeasonSummary[]
): Promise<string | null> {
  if (observed.length === 0) return null;
  try {
    const seasons = seasonSummaries ?? (await getTv(tmdbId)).seasons;
    const scores: OrderingScore[] = await scoreOrderings(tmdbId, seasons, observed);
    return bestOrdering(scores, null)?.id ?? null;
  } catch (err) {
    console.warn(`[ordering] could not choose an ordering for TMDB ${tmdbId}:`, err);
    return null;
  }
}

/** The coordinates an on-disk series folder uses (for `orderingForImport`). */
export async function coordinatesOnDisk(seriesPath: string): Promise<ObservedCoordinate[]> {
  return observedCoordinates(seriesPath);
}
