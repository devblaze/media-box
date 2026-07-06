import type { NextRequest } from "next/server";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { addSeries } from "@/server/library/series-service";
import { enqueueCommand } from "@/server/jobs/scheduler";
import { ok, serverError } from "@/lib/http";

export async function GET() {
  try {
    const db = getDb();
    const rows = db
      .select({
        id: schema.series.id,
        tmdbId: schema.series.tmdbId,
        title: schema.series.title,
        sortTitle: schema.series.sortTitle,
        year: schema.series.year,
        status: schema.series.status,
        network: schema.series.network,
        posterPath: schema.series.posterPath,
        path: schema.series.path,
        monitored: schema.series.monitored,
        monitorMode: schema.series.monitorMode,
        isAnime: schema.series.isAnime,
        qualityProfileId: schema.series.qualityProfileId,
        episodeCount: sql<number>`(SELECT COUNT(*) FROM episodes e WHERE e.series_id = ${schema.series.id} AND e.season_number > 0)`,
        episodeFileCount: sql<number>`(SELECT COUNT(*) FROM episodes e WHERE e.series_id = ${schema.series.id} AND e.season_number > 0 AND e.episode_file_id IS NOT NULL)`,
        addedAt: schema.series.addedAt,
      })
      .from(schema.series)
      .orderBy(asc(schema.series.sortTitle))
      .all();

    // Latest episode-file import time per series → the series' "imported at".
    const importedBySeries = new Map<number, number>();
    const fileRows = db
      .select({ seriesId: schema.episodes.seriesId, dateAdded: schema.episodeFiles.dateAdded })
      .from(schema.episodeFiles)
      .innerJoin(schema.episodes, eq(schema.episodes.episodeFileId, schema.episodeFiles.id))
      .all();
    for (const f of fileRows) {
      if (!f.dateAdded) continue;
      const ms = f.dateAdded.getTime();
      if (ms > (importedBySeries.get(f.seriesId) ?? 0)) importedBySeries.set(f.seriesId, ms);
    }

    return ok(
      rows.map(({ addedAt, ...r }) => ({
        ...r,
        addedAt: addedAt ? addedAt.getTime() : 0,
        importedAt: importedBySeries.get(r.id) ?? null,
      }))
    );
  } catch (err) {
    return serverError(err);
  }
}

const addSchema = z.object({
  tmdbId: z.number().int().positive(),
  rootFolderId: z.number().int().positive(),
  qualityProfileId: z.number().int().positive(),
  monitored: z.boolean().optional(),
  monitorMode: z.enum(["all", "future", "none"]).optional(),
  seasonFolder: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const input = addSchema.parse(await request.json());
    const row = await addSeries(input);
    // pick up any pre-existing files in the folder
    enqueueCommand("DiskScan", { seriesId: row.id }, "system");
    return ok(row, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
