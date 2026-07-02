import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { refreshSeries } from "@/server/library/series-service";

export async function refreshSeriesHandler(payload: unknown): Promise<string> {
  const db = getDb();
  const p = payload as { seriesId?: number } | null;
  if (p?.seriesId) {
    await refreshSeries(p.seriesId);
    return `refreshed series ${p.seriesId}`;
  }
  const all = db
    .select({ id: schema.series.id })
    .from(schema.series)
    .where(eq(schema.series.monitored, true))
    .all();
  let failed = 0;
  for (const s of all) {
    try {
      await refreshSeries(s.id);
    } catch (err) {
      failed++;
      console.error(`[refresh-series] series ${s.id} failed:`, err);
    }
  }
  return `refreshed ${all.length - failed}/${all.length} series`;
}
