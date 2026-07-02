import type { NextRequest } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { deleteSeries, applyMonitorMode } from "@/server/library/series-service";
import { badRequest, notFound, ok, serverError } from "@/lib/http";
import { emitEvent } from "@/server/events/bus";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/v1/series/[id]">) {
  try {
    const { id } = await ctx.params;
    const seriesId = Number(id);
    const db = getDb();
    const row = db.select().from(schema.series).where(eq(schema.series.id, seriesId)).get();
    if (!row) return notFound("Series not found");
    const seasonRows = db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.seriesId, seriesId))
      .orderBy(asc(schema.seasons.seasonNumber))
      .all();
    const episodeRows = db
      .select()
      .from(schema.episodes)
      .where(eq(schema.episodes.seriesId, seriesId))
      .orderBy(asc(schema.episodes.seasonNumber), asc(schema.episodes.episodeNumber))
      .all();
    const fileRows = db
      .select()
      .from(schema.episodeFiles)
      .where(eq(schema.episodeFiles.seriesId, seriesId))
      .all();
    return ok({ ...row, seasons: seasonRows, episodes: episodeRows, files: fileRows });
  } catch (err) {
    return serverError(err);
  }
}

const patchSchema = z.object({
  monitored: z.boolean().optional(),
  monitorMode: z.enum(["all", "future", "none"]).optional(),
  qualityProfileId: z.number().int().positive().optional(),
  seasonFolder: z.boolean().optional(),
  seasons: z
    .array(z.object({ seasonNumber: z.number().int(), monitored: z.boolean() }))
    .optional(),
  episodes: z.array(z.object({ id: z.number().int(), monitored: z.boolean() })).optional(),
});

export async function PUT(request: NextRequest, ctx: RouteContext<"/api/v1/series/[id]">) {
  try {
    const { id } = await ctx.params;
    const seriesId = Number(id);
    const db = getDb();
    const existing = db.select().from(schema.series).where(eq(schema.series.id, seriesId)).get();
    if (!existing) return notFound("Series not found");

    const patch = patchSchema.parse(await request.json());
    const {
      seasons: seasonPatches,
      episodes: episodePatches,
      monitorMode,
      ...seriesPatch
    } = patch;

    if (Object.keys(seriesPatch).length > 0) {
      db.update(schema.series).set(seriesPatch).where(eq(schema.series.id, seriesId)).run();
    }
    // Changing the monitor mode re-derives every episode/season monitored flag.
    if (monitorMode) {
      applyMonitorMode(seriesId, monitorMode);
    }
    for (const sp of seasonPatches ?? []) {
      db.update(schema.seasons)
        .set({ monitored: sp.monitored })
        .where(
          and(eq(schema.seasons.seriesId, seriesId), eq(schema.seasons.seasonNumber, sp.seasonNumber))
        )
        .run();
      db.update(schema.episodes)
        .set({ monitored: sp.monitored })
        .where(
          and(eq(schema.episodes.seriesId, seriesId), eq(schema.episodes.seasonNumber, sp.seasonNumber))
        )
        .run();
    }
    for (const ep of episodePatches ?? []) {
      db.update(schema.episodes)
        .set({ monitored: ep.monitored })
        .where(and(eq(schema.episodes.id, ep.id), eq(schema.episodes.seriesId, seriesId)))
        .run();
    }
    emitEvent({ type: "series.updated", seriesId });
    return ok(db.select().from(schema.series).where(eq(schema.series.id, seriesId)).get());
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/v1/series/[id]">) {
  try {
    const { id } = await ctx.params;
    const seriesId = Number(id);
    if (!Number.isInteger(seriesId)) return badRequest("Invalid id");
    const deleteFiles = request.nextUrl.searchParams.get("deleteFiles") === "true";
    await deleteSeries(seriesId, deleteFiles);
    return ok({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}
