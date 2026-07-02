import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { refreshMovie } from "@/server/library/movie-service";

export async function refreshMoviesHandler(payload: unknown): Promise<string> {
  const db = getDb();
  const p = payload as { movieId?: number } | null;
  if (p?.movieId) {
    await refreshMovie(p.movieId);
    return `refreshed movie ${p.movieId}`;
  }
  const all = db
    .select({ id: schema.movies.id })
    .from(schema.movies)
    .where(eq(schema.movies.monitored, true))
    .all();
  let failed = 0;
  for (const m of all) {
    try {
      await refreshMovie(m.id);
    } catch (err) {
      failed++;
      console.error(`[refresh-movies] movie ${m.id} failed:`, err);
    }
  }
  return `refreshed ${all.length - failed}/${all.length} movies`;
}
