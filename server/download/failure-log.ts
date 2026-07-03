import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { emitEvent } from "@/server/events/bus";
import type { QualityModel } from "@/server/parser/quality";

export interface FailureInput {
  mediaType: "series" | "movie";
  seriesId?: number | null;
  movieId?: number | null;
  episodeIds?: number[] | null;
  sourceTitle: string;
  quality?: QualityModel | null;
  indexerId?: number | null;
  downloadClientId?: number | null;
  downloadExternalId?: string | null;
  reason: string;
  /** Where in the pipeline it failed — shown/grouped in the failures calendar. */
  stage: "grab" | "download" | "fetch" | "import";
}

/**
 * Persist a durable, media-linked failure into `history` (eventType
 * `downloadFailed`) so the admin failures calendar can show it and rebuild an
 * interactive-search scope. The season number is resolved here (history has no
 * season column) so the UI can reconstruct a `{seriesId, season}` scope for
 * season packs. Best-effort — never throws into the caller's failure path.
 */
export function recordDownloadFailure(input: FailureInput): void {
  try {
    const db = getDb();
    const episodeId = input.episodeIds?.[0] ?? null;
    let seasonNumber: number | null = null;
    if (episodeId) {
      const ep = db
        .select({ season: schema.episodes.seasonNumber })
        .from(schema.episodes)
        .where(eq(schema.episodes.id, episodeId))
        .get();
      seasonNumber = ep?.season ?? null;
    }
    db.insert(schema.history)
      .values({
        eventType: "downloadFailed",
        mediaType: input.mediaType,
        seriesId: input.seriesId ?? null,
        movieId: input.movieId ?? null,
        episodeId,
        sourceTitle: input.sourceTitle,
        quality: input.quality ?? null,
        indexerId: input.indexerId ?? null,
        downloadClientId: input.downloadClientId ?? null,
        downloadExternalId: input.downloadExternalId ?? null,
        data: { reason: input.reason, stage: input.stage, seasonNumber },
        date: new Date(),
      })
      .run();
    emitEvent({ type: "history.added" });
  } catch (err) {
    console.warn(
      "[failure-log] could not record failure:",
      err instanceof Error ? err.message : err
    );
  }
}
