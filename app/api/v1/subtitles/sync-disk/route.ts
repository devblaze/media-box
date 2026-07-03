import type { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { requireAdmin } from "@/server/auth/guards";
import { syncDiskSubtitles } from "@/server/subtitles/subtitle-service";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  movieId: z.coerce.number().int().positive().optional(),
  episodeId: z.coerce.number().int().positive().optional(),
  seriesId: z.coerce.number().int().positive().optional(),
});

/**
 * Discover subtitle files already on disk (sidecars + Subs/ folders) and record
 * any not yet known so they show up as tracks. Targets a movie, an episode, or a
 * whole series (all its episodes with files). Admin only.
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const b = bodySchema.parse(await request.json());
    if (b.movieId) {
      await syncDiskSubtitles({ movieId: b.movieId });
    } else if (b.episodeId) {
      await syncDiskSubtitles({ episodeId: b.episodeId });
    } else if (b.seriesId) {
      const eps = getDb()
        .select({ id: schema.episodes.id })
        .from(schema.episodes)
        .where(
          and(eq(schema.episodes.seriesId, b.seriesId), isNotNull(schema.episodes.episodeFileId))
        )
        .all();
      for (const e of eps) await syncDiskSubtitles({ episodeId: e.id });
    } else {
      return badRequest("Provide movieId, episodeId, or seriesId");
    }
    return ok({ synced: true });
  } catch (err) {
    return serverError(err);
  }
}
