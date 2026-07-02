import path from "node:path";
import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getTv, getTvSeason } from "@/server/metadata/tmdb";
import { mapSeries } from "@/server/metadata/tmdb-map";
import { renderSeriesFolder } from "./naming";
import { emitEvent } from "@/server/events/bus";

export interface AddSeriesInput {
  tmdbId: number;
  rootFolderId: number;
  qualityProfileId: number;
  monitored?: boolean;
  seasonFolder?: boolean;
  /** Import an existing on-disk folder in place instead of deriving the path from the naming template. */
  path?: string;
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
      seasonFolder: input.seasonFolder ?? true,
      addedAt: new Date(),
    })
    .returning()
    .get();

  await fs.mkdir(seriesPath, { recursive: true });
  await syncSeasonsAndEpisodes(row.id, input.tmdbId, details.seasons);

  db.update(schema.series)
    .set({ lastRefreshAt: new Date() })
    .where(eq(schema.series.id, row.id))
    .run();
  emitEvent({ type: "series.updated", seriesId: row.id });
  return row;
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

export async function deleteSeries(seriesId: number, deleteFiles: boolean) {
  const db = getDb();
  const row = db.select().from(schema.series).where(eq(schema.series.id, seriesId)).get();
  if (!row) return;
  db.delete(schema.series).where(eq(schema.series.id, seriesId)).run();
  if (deleteFiles) {
    await fs.rm(row.path, { recursive: true, force: true });
  }
  emitEvent({ type: "series.updated", seriesId });
}
