import { scanAll, scanMovie, scanSeries } from "@/server/library/disk-scanner";

export async function diskScanHandler(payload: unknown): Promise<string> {
  const p = payload as { seriesId?: number; movieId?: number } | null;
  if (p?.seriesId) {
    const added = await scanSeries(p.seriesId);
    return `series ${p.seriesId}: ${added} new files`;
  }
  if (p?.movieId) {
    const added = await scanMovie(p.movieId);
    return `movie ${p.movieId}: ${added} new files`;
  }
  return scanAll();
}
