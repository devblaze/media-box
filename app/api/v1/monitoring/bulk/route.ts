import type { NextRequest } from "next/server";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { requireAdmin } from "@/server/auth/guards";
import { applyMonitorMode } from "@/server/library/series-service";
import { ok, badRequest, serverError } from "@/lib/http";
import { emitEvent } from "@/server/events/bus";

export const runtime = "nodejs";

const bulkSchema = z.object({
  items: z
    .array(
      z.object({
        type: z.enum(["movie", "series"]),
        id: z.number().int().positive(),
        monitored: z.boolean().optional(),
      })
    )
    .min(1),
  // When set, bulk-apply this monitor mode to the (series) items instead of a
  // plain monitored on/off.
  monitorMode: z.enum(["all", "future", "none"]).optional(),
});

/**
 * Bulk-set the `monitored` flag on many movies/series in a single request.
 *
 * Items are bucketed by (type, monitored) so the whole payload collapses into at
 * most four `UPDATE ... WHERE id IN (...)` statements regardless of how many rows
 * are toggled. Per-row `series.updated` / `movie.updated` events are emitted so
 * SSE-driven views refresh.
 */
export async function POST(request: NextRequest) {
  try {
    const denied = requireAdmin(request);
    if (denied) return denied;

    const { items, monitorMode } = bulkSchema.parse(await request.json());
    const db = getDb();

    // Bulk monitor-MODE: re-derive episode/season flags for each series item.
    if (monitorMode) {
      const seriesIds = [...new Set(items.filter((i) => i.type === "series").map((i) => i.id))];
      for (const id of seriesIds) applyMonitorMode(id, monitorMode); // emits series.updated
      return ok({ updated: seriesIds.length });
    }

    // Otherwise a plain monitored on/off. Dedupe by row; a later entry wins.
    const seriesState = new Map<number, boolean>();
    const movieState = new Map<number, boolean>();
    for (const item of items) {
      if (item.monitored === undefined) continue;
      (item.type === "series" ? seriesState : movieState).set(item.id, item.monitored);
    }
    if (seriesState.size === 0 && movieState.size === 0) {
      return badRequest("Provide `monitored` on items or a `monitorMode`");
    }

    const idsWhere = (state: Map<number, boolean>, monitored: boolean) =>
      [...state.entries()].filter(([, m]) => m === monitored).map(([id]) => id);

    const seriesOn = idsWhere(seriesState, true);
    const seriesOff = idsWhere(seriesState, false);
    const moviesOn = idsWhere(movieState, true);
    const moviesOff = idsWhere(movieState, false);

    let updated = 0;
    if (seriesOn.length) {
      updated += db
        .update(schema.series)
        .set({ monitored: true })
        .where(inArray(schema.series.id, seriesOn))
        .run().changes;
    }
    if (seriesOff.length) {
      updated += db
        .update(schema.series)
        .set({ monitored: false })
        .where(inArray(schema.series.id, seriesOff))
        .run().changes;
    }
    if (moviesOn.length) {
      updated += db
        .update(schema.movies)
        .set({ monitored: true })
        .where(inArray(schema.movies.id, moviesOn))
        .run().changes;
    }
    if (moviesOff.length) {
      updated += db
        .update(schema.movies)
        .set({ monitored: false })
        .where(inArray(schema.movies.id, moviesOff))
        .run().changes;
    }

    for (const seriesId of seriesState.keys()) emitEvent({ type: "series.updated", seriesId });
    for (const movieId of movieState.keys()) emitEvent({ type: "movie.updated", movieId });

    return ok({ updated });
  } catch (err) {
    return serverError(err);
  }
}
