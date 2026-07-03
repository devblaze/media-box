import type { NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { ok, serverError } from "@/lib/http";
import { requireAdmin } from "@/server/auth/guards";

/**
 * Merge duplicate quality profiles that share a name (case-insensitive).
 *
 * For each name group with more than one profile the lowest-id row is kept as
 * the canonical profile; every series/movie pointing at a duplicate is
 * reassigned to the canonical id first, then the duplicate rows are deleted.
 * Reassign-before-delete keeps the operation safe (nothing is ever left
 * pointing at a deleted profile) and idempotent (a second run is a no-op).
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const db = getDb();
    const all = db
      .select()
      .from(schema.qualityProfiles)
      .orderBy(asc(schema.qualityProfiles.id))
      .all();

    const groups = new Map<string, typeof all>();
    for (const p of all) {
      const key = p.name.trim().toLowerCase();
      const group = groups.get(key) ?? [];
      group.push(p);
      groups.set(key, group);
    }

    let merged = 0;
    let reassignedSeries = 0;
    let reassignedMovies = 0;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const [canonical, ...dupes] = group; // asc order => lowest id is canonical
      for (const dup of dupes) {
        reassignedSeries += db
          .update(schema.series)
          .set({ qualityProfileId: canonical.id })
          .where(eq(schema.series.qualityProfileId, dup.id))
          .run().changes;
        reassignedMovies += db
          .update(schema.movies)
          .set({ qualityProfileId: canonical.id })
          .where(eq(schema.movies.qualityProfileId, dup.id))
          .run().changes;
        db.delete(schema.qualityProfiles).where(eq(schema.qualityProfiles.id, dup.id)).run();
        merged++;
      }
    }

    return ok({ merged, reassignedSeries, reassignedMovies });
  } catch (err) {
    return serverError(err);
  }
}
