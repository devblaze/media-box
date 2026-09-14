import path from "node:path";
import fs from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getTv } from "@/server/metadata/tmdb";
import {
  buildEpisodeOrder,
  defaultEpisodeGroupId,
  type SeasonSummary,
} from "@/server/metadata/episode-order";
import { mapSeries } from "@/server/metadata/tmdb-map";
import { airDateToUtc } from "@/server/metadata/air-time";
import { renderSeriesFolder } from "./naming";
import { removeMedia } from "./filesystem";
import { assertFileOperationsEnabled } from "./media-guard";
import { holdOrRun } from "./file-change-service";
import { recordLog } from "@/server/logging/logger";
import { emitEvent } from "@/server/events/bus";

export interface AddSeriesInput {
  tmdbId: number;
  rootFolderId: number;
  qualityProfileId: number;
  monitored?: boolean;
  seasonFolder?: boolean;
  /** Which episodes to monitor: all / future (next) only / none. */
  monitorMode?: "all" | "future" | "none";
  /** Import an existing on-disk folder in place instead of deriving the path from the naming template. */
  path?: string;
  /** Mark the series as anime (separate library type). */
  isAnime?: boolean;
  /**
   * Season ordering to pin (a TMDB episode-group id, or null for TMDB's aired
   * order). Omit to decide automatically — importers that can see how the source
   * numbers the show pass what they worked out; see `orderingForImport`.
   */
  episodeGroupId?: string | null;
}

export async function addSeries(input: AddSeriesInput) {
  const db = getDb();

  const existing = db
    .select({ id: schema.series.id })
    .from(schema.series)
    .where(eq(schema.series.tmdbId, input.tmdbId))
    .get();
  if (existing) throw new Error("Series is already in the library");

  const rootFolder = db
    .select()
    .from(schema.rootFolders)
    .where(eq(schema.rootFolders.id, input.rootFolderId))
    .get();
  if (!rootFolder) throw new Error("Root folder not found");

  const details = await getTv(input.tmdbId);
  const mapped = mapSeries(details);
  const naming = db.select().from(schema.namingConfig).get();
  const template = naming?.seriesFolderFormat?.trim() || "{Series Title} ({Year})";
  const folderName = renderSeriesFolder(template, { title: mapped.title, year: mapped.year });
  const seriesPath = input.path ?? path.join(rootFolder.path, folderName);

  // Anime get TMDB's "TVDB Order" grouping when it exists, so their seasons match
  // Jellyfin, the folders on disk and how releases are named (see episode-order.ts).
  const isAnime = input.isAnime ?? false;
  const episodeGroupId =
    input.episodeGroupId !== undefined
      ? input.episodeGroupId
      : await defaultEpisodeGroupId(input.tmdbId, isAnime);

  const row = db
    .insert(schema.series)
    .values({
      ...mapped,
      path: seriesPath,
      rootFolderId: rootFolder.id,
      qualityProfileId: input.qualityProfileId,
      monitored: input.monitored ?? true,
      monitorMode: input.monitorMode ?? "all",
      seasonFolder: input.seasonFolder ?? true,
      isAnime,
      episodeGroupId,
      addedAt: new Date(),
    })
    .returning()
    .get();

  await fs.mkdir(seriesPath, { recursive: true });
  await syncSeasonsAndEpisodes(row.id, input.tmdbId, details.seasons, episodeGroupId);
  applyMonitorMode(row.id, input.monitorMode ?? "all");

  db.update(schema.series)
    .set({ lastRefreshAt: new Date() })
    .where(eq(schema.series.id, row.id))
    .run();
  emitEvent({ type: "series.updated", seriesId: row.id });
  return row;
}

/**
 * Set which episodes of a series are monitored, per the chosen mode:
 * - `all`    — every regular (non-special) episode is monitored.
 * - `future` — only unaired / upcoming episodes are monitored (the "next episodes".)
 * - `none`   — nothing is monitored (and the series itself is unmonitored).
 *
 * Seasons are marked monitored when they contain at least one monitored episode,
 * and `series.monitored` follows the mode. Season 0 (specials) is never
 * auto-monitored, but an explicit opt-in (its season/episode toggles) is
 * preserved across mode changes ("none" still clears everything).
 */
export function applyMonitorMode(seriesId: number, mode: "all" | "future" | "none") {
  const db = getDb();
  const now = Date.now();

  const eps = db
    .select({
      id: schema.episodes.id,
      seasonNumber: schema.episodes.seasonNumber,
      airDateUtc: schema.episodes.airDateUtc,
      monitored: schema.episodes.monitored,
    })
    .from(schema.episodes)
    .where(eq(schema.episodes.seriesId, seriesId))
    .all();

  const monitoredSeasons = new Set<number>();
  for (const ep of eps) {
    let monitored: boolean;
    if (mode === "none") monitored = false;
    // Specials are never AUTO-monitored, but a user's explicit opt-in (the
    // Specials season toggle) must survive monitor-mode changes — so preserve
    // each season-0 episode's current flag instead of force-clearing it.
    else if (ep.seasonNumber === 0) monitored = ep.monitored;
    else if (mode === "all") monitored = true;
    else monitored = !ep.airDateUtc || ep.airDateUtc.getTime() >= now; // future: unaired/upcoming
    db.update(schema.episodes).set({ monitored }).where(eq(schema.episodes.id, ep.id)).run();
    if (monitored) monitoredSeasons.add(ep.seasonNumber);
  }

  const seasonRows = db
    .select({ seasonNumber: schema.seasons.seasonNumber })
    .from(schema.seasons)
    .where(eq(schema.seasons.seriesId, seriesId))
    .all();
  for (const s of seasonRows) {
    db.update(schema.seasons)
      .set({ monitored: monitoredSeasons.has(s.seasonNumber) })
      .where(
        and(eq(schema.seasons.seriesId, seriesId), eq(schema.seasons.seasonNumber, s.seasonNumber))
      )
      .run();
  }

  db.update(schema.series)
    .set({ monitored: mode !== "none", monitorMode: mode })
    .where(eq(schema.series.id, seriesId))
    .run();
  emitEvent({ type: "series.updated", seriesId });
}

/**
 * Coordinates are shifted this far out of the way before a renumber so the
 * (series, season, episode) unique index can't trip while rows swap places.
 */
const VACATE_SEASON_OFFSET = 100_000;

const coordKey = (seasonNumber: number, episodeNumber: number) =>
  `${seasonNumber}:${episodeNumber}`;

/**
 * Pull the season/episode list from TMDB — in the ordering the series is pinned to
 * (`episodeGroupId`; null = TMDB's aired order) — and reconcile it into the DB.
 *
 * Rows are matched on `tmdbEpisodeId` first, so switching a show's ordering
 * *renumbers* its episodes in place instead of duplicating them: watch progress,
 * subtitles and file links all follow the episode they belong to. Rows the new
 * ordering no longer contains are dropped when nothing is attached to them; one
 * that still holds a file keeps its old slot if it's free, and otherwise gives the
 * file up for the next disk scan to re-match (the file on disk is never touched).
 */
export async function syncSeasonsAndEpisodes(
  seriesId: number,
  tmdbId: number,
  seasonSummaries: SeasonSummary[],
  episodeGroupId: string | null = null
) {
  const db = getDb();
  // Origin country places each episode's air time in the right zone (see air-time.ts);
  // the series row was already upserted with it before this runs.
  const originCountry =
    db
      .select({ originCountry: schema.series.originCountry })
      .from(schema.series)
      .where(eq(schema.series.id, seriesId))
      .get()?.originCountry ?? null;

  const ordered = await buildEpisodeOrder(tmdbId, seasonSummaries, episodeGroupId);
  if (ordered.length === 0) return;

  const existing = db
    .select()
    .from(schema.episodes)
    .where(eq(schema.episodes.seriesId, seriesId))
    .all();
  const byTmdbId = new Map<number, (typeof existing)[number]>();
  const byCoord = new Map<string, (typeof existing)[number]>();
  for (const row of existing) {
    if (row.tmdbEpisodeId != null && !byTmdbId.has(row.tmdbEpisodeId)) {
      byTmdbId.set(row.tmdbEpisodeId, row);
    }
    byCoord.set(coordKey(row.seasonNumber, row.episodeNumber), row);
  }
  const targetTmdbIds = new Set(ordered.map((e) => e.tmdbEpisodeId));

  // Pair every incoming episode with the row it should update (by TMDB id, else by
  // the slot it already occupies — but never steal a slot another episode owns).
  const claimed = new Set<number>();
  const plan = ordered.map((ep) => {
    let row = byTmdbId.get(ep.tmdbEpisodeId);
    if (row && claimed.has(row.id)) row = undefined;
    if (!row) {
      const atCoord = byCoord.get(coordKey(ep.seasonNumber, ep.episodeNumber));
      if (
        atCoord &&
        !claimed.has(atCoord.id) &&
        (atCoord.tmdbEpisodeId == null || !targetTmdbIds.has(atCoord.tmdbEpisodeId))
      ) {
        row = atCoord;
      }
    }
    if (row) claimed.add(row.id);
    return { ep, row };
  });

  const renumbering = plan.some(
    ({ ep, row }) =>
      row && (row.seasonNumber !== ep.seasonNumber || row.episodeNumber !== ep.episodeNumber)
  );
  if (renumbering) {
    db.update(schema.episodes)
      .set({ seasonNumber: sql`${schema.episodes.seasonNumber} + ${VACATE_SEASON_OFFSET}` })
      .where(eq(schema.episodes.seriesId, seriesId))
      .run();
  }

  for (const { ep, row } of plan) {
    const values = {
      seasonNumber: ep.seasonNumber,
      episodeNumber: ep.episodeNumber,
      absoluteNumber: ep.absoluteNumber,
      tmdbEpisodeId: ep.tmdbEpisodeId,
      title: ep.title,
      overview: ep.overview,
      airDateUtc: airDateToUtc(ep.airDate, originCountry),
      runtime: ep.runtime,
    };
    if (row) {
      db.update(schema.episodes).set(values).where(eq(schema.episodes.id, row.id)).run();
    } else {
      db.insert(schema.episodes)
        .values({ seriesId, monitored: ep.seasonNumber !== 0, ...values })
        .run();
    }
  }

  // Rows the new ordering doesn't cover (TMDB dropped them, or an ordering change
  // left them behind). Give a file-holding one its old slot back when it's still
  // free; otherwise drop the row and its file record so a rescan can re-match it.
  const occupied = new Set(plan.map(({ ep }) => coordKey(ep.seasonNumber, ep.episodeNumber)));
  for (const row of existing) {
    if (claimed.has(row.id)) continue;
    const home = coordKey(row.seasonNumber, row.episodeNumber);
    if (row.episodeFileId != null && !occupied.has(home)) {
      occupied.add(home);
      db.update(schema.episodes)
        .set({ seasonNumber: row.seasonNumber, episodeNumber: row.episodeNumber })
        .where(eq(schema.episodes.id, row.id))
        .run();
      continue;
    }
    // Drop the episode row, but KEEP its file record. The file is still on disk,
    // and deleting the record was losing the only trace of it: every "do we
    // already have this?" check reads the episode's pointer, so the episode read
    // as missing, got downloaded again, and the new copy landed beside the old
    // one under a different name. A surviving record leaves the file findable —
    // by a rescan, and by GET /api/v1/library/integrity, which reports records
    // nothing points at.
    if (row.episodeFileId != null) {
      recordLog("warn", "Episode ordering no longer covers a file that is still on disk", {
        source: "library",
        context: {
          seriesId,
          season: row.seasonNumber,
          episode: row.episodeNumber,
          episodeFileId: row.episodeFileId,
        },
      });
    }
    db.delete(schema.episodes).where(eq(schema.episodes.id, row.id)).run();
  }

  // Season rows follow the episodes: add what's new, drop what no longer exists.
  const wantedSeasons = new Set(ordered.map((e) => e.seasonNumber));
  const seasonRows = db
    .select()
    .from(schema.seasons)
    .where(eq(schema.seasons.seriesId, seriesId))
    .all();
  const haveSeasons = new Set(seasonRows.map((r) => r.seasonNumber));
  for (const seasonNumber of wantedSeasons) {
    if (haveSeasons.has(seasonNumber)) continue;
    db.insert(schema.seasons)
      .values({ seriesId, seasonNumber, monitored: seasonNumber !== 0 })
      .run();
  }
  for (const row of seasonRows) {
    if (!wantedSeasons.has(row.seasonNumber)) {
      db.delete(schema.seasons).where(eq(schema.seasons.id, row.id)).run();
    }
  }
}

/**
 * Re-number a series onto another TMDB ordering (`episodeGroupId`, null = aired).
 *
 * Every episode↔file link is dropped first and the series is rescanned afterwards:
 * the numbering the files carry on disk is the one the *new* ordering uses, so
 * re-matching them from scratch is both correct and self-healing — it also clears
 * out mismatches the previous ordering left behind. The file *records* survive
 * (the rescan re-attaches them), and nothing on disk is moved or deleted.
 */
export async function setEpisodeOrdering(seriesId: number, episodeGroupId: string | null) {
  const db = getDb();
  const row = db.select().from(schema.series).where(eq(schema.series.id, seriesId)).get();
  if (!row) throw new Error(`Series ${seriesId} not found`);
  if ((row.episodeGroupId ?? null) === episodeGroupId) return;

  db.update(schema.episodes)
    .set({ episodeFileId: null })
    .where(eq(schema.episodes.seriesId, seriesId))
    .run();
  db.update(schema.series).set({ episodeGroupId }).where(eq(schema.series.id, seriesId)).run();

  await refreshSeries(seriesId);
  const { scanSeries } = await import("./disk-scanner");
  await scanSeries(seriesId);
  emitEvent({ type: "series.updated", seriesId });
}

export async function refreshSeries(seriesId: number) {
  const db = getDb();
  const row = db.select().from(schema.series).where(eq(schema.series.id, seriesId)).get();
  if (!row) throw new Error(`Series ${seriesId} not found`);
  const details = await getTv(row.tmdbId);
  const mapped = mapSeries(details);
  db.update(schema.series)
    .set({ ...mapped, lastRefreshAt: new Date() })
    .where(eq(schema.series.id, seriesId))
    .run();
  await syncSeasonsAndEpisodes(seriesId, row.tmdbId, details.seasons, row.episodeGroupId ?? null);
  emitEvent({ type: "series.updated", seriesId });
}

/**
 * Re-identify a series/anime as a different TMDB title. Swaps the TMDB id then
 * re-pulls metadata and re-syncs seasons/episodes from the new show. Episode
 * files key off the internal series id (and episode number), so already-imported
 * files survive; note that if the new show has fewer episodes, stale episode rows
 * from the old show are left in place.
 */
export async function reidentifySeries(seriesId: number, newTmdbId: number) {
  const db = getDb();
  const row = db.select().from(schema.series).where(eq(schema.series.id, seriesId)).get();
  if (!row) throw new Error("Series not found");
  if (row.tmdbId === newTmdbId) return; // already this title
  const clash = db
    .select({ id: schema.series.id })
    .from(schema.series)
    .where(eq(schema.series.tmdbId, newTmdbId))
    .get()?.id;
  if (clash != null && clash !== seriesId) {
    throw new Error("Another series in your library already uses that TMDB title.");
  }
  // The episode grouping belonged to the OLD show — re-pick one for the new title.
  const episodeGroupId = await defaultEpisodeGroupId(newTmdbId, row.isAnime);
  db.update(schema.series)
    .set({ tmdbId: newTmdbId, episodeGroupId })
    .where(eq(schema.series.id, seriesId))
    .run();
  await refreshSeries(seriesId); // re-pull metadata + re-sync seasons/episodes
}

export async function deleteSeries(
  seriesId: number,
  deleteFiles: boolean,
  opts: { bypassHold?: boolean } = {}
): Promise<void | { held: true; id: number }> {
  const db = getDb();
  const row = db.select().from(schema.series).where(eq(schema.series.id, seriesId)).get();
  if (!row) return;

  const run = async () => {
    // Refuse before touching the DB so read-only mode leaves DB and disk consistent.
    if (deleteFiles) assertFileOperationsEnabled();
    db.delete(schema.series).where(eq(schema.series.id, seriesId)).run();
    if (deleteFiles) {
      await removeMedia(row.path, { recursive: true });
    }
    emitEvent({ type: "series.updated", seriesId });
  };

  // Only a with-files delete is a file operation worth holding; a library-only
  // delete (deleteFiles=false) never touches disk, so it always runs.
  if (!deleteFiles || opts.bypassHold) {
    await run();
    return;
  }
  const outcome = await holdOrRun(
    "deleteSeries",
    `Delete “${row.title}” and its files`,
    row.path,
    { seriesId, deleteFiles: true },
    run
  );
  if (outcome.held) return { held: true, id: outcome.id };
}
