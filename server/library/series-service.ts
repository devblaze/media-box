import path from "node:path";
import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getTv, getTvSeason } from "@/server/metadata/tmdb";
import { mapSeries } from "@/server/metadata/tmdb-map";
import { renderSeriesFolder } from "./naming";
import { removeMedia } from "./filesystem";
import { assertFileOperationsEnabled } from "./media-guard";
import { holdOrRun } from "./file-change-service";
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
      isAnime: input.isAnime ?? false,
      addedAt: new Date(),
    })
    .returning()
    .get();

  await fs.mkdir(seriesPath, { recursive: true });
  await syncSeasonsAndEpisodes(row.id, input.tmdbId, details.seasons);
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
 * and `series.monitored` follows the mode. Season 0 (specials) is never auto-monitored.
 */
export function applyMonitorMode(seriesId: number, mode: "all" | "future" | "none") {
  const db = getDb();
  const now = Date.now();

  const eps = db
    .select({
      id: schema.episodes.id,
      seasonNumber: schema.episodes.seasonNumber,
      airDateUtc: schema.episodes.airDateUtc,
    })
    .from(schema.episodes)
    .where(eq(schema.episodes.seriesId, seriesId))
    .all();

  const monitoredSeasons = new Set<number>();
  for (const ep of eps) {
    let monitored: boolean;
    if (mode === "none" || ep.seasonNumber === 0) monitored = false;
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

// Pull season/episode lists from TMDB and upsert; never deletes files' episodes.
export async function syncSeasonsAndEpisodes(
  seriesId: number,
  tmdbId: number,
  seasonSummaries: { season_number: number }[]
) {
  const db = getDb();
  for (const s of seasonSummaries) {
    const seasonNumber = s.season_number;
    const existingSeason = db
      .select()
      .from(schema.seasons)
      .where(and(eq(schema.seasons.seriesId, seriesId), eq(schema.seasons.seasonNumber, seasonNumber)))
      .get();
    if (!existingSeason) {
      db.insert(schema.seasons)
        .values({ seriesId, seasonNumber, monitored: seasonNumber !== 0 })
        .run();
    }

    const season = await getTvSeason(tmdbId, seasonNumber);
    for (const ep of season.episodes) {
      const values = {
        tmdbEpisodeId: ep.id,
        title: ep.name ?? null,
        overview: ep.overview ?? null,
        airDateUtc: ep.air_date ? new Date(`${ep.air_date}T00:00:00Z`) : null,
        runtime: ep.runtime ?? null,
      };
      const existing = db
        .select({ id: schema.episodes.id })
        .from(schema.episodes)
        .where(
          and(
            eq(schema.episodes.seriesId, seriesId),
            eq(schema.episodes.seasonNumber, ep.season_number),
            eq(schema.episodes.episodeNumber, ep.episode_number)
          )
        )
        .get();
      if (existing) {
        db.update(schema.episodes).set(values).where(eq(schema.episodes.id, existing.id)).run();
      } else {
        db.insert(schema.episodes)
          .values({
            seriesId,
            seasonNumber: ep.season_number,
            episodeNumber: ep.episode_number,
            monitored: ep.season_number !== 0,
            ...values,
          })
          .run();
      }
    }
  }
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
  await syncSeasonsAndEpisodes(seriesId, row.tmdbId, details.seasons);
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
  db.update(schema.series).set({ tmdbId: newTmdbId }).where(eq(schema.series.id, seriesId)).run();
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
