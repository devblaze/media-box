import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { addMovie } from "@/server/library/movie-service";
import { addSeries } from "@/server/library/series-service";
import { enqueueCommand } from "@/server/jobs/scheduler";
import { emitEvent } from "@/server/events/bus";
import { notifyRequestAvailable } from "@/server/notifications/pushover";

/** Approve a request: add the media to the library (monitored) and kick off a search. */
export async function approveRequest(requestId: number, adminUserId: number) {
  const db = getDb();
  const request = db.select().from(schema.requests).where(eq(schema.requests.id, requestId)).get();
  if (!request) throw new Error("Request not found");
  if (request.status !== "pending") throw new Error("Request is not pending");

  const rootFolder = db
    .select()
    .from(schema.rootFolders)
    .where(eq(schema.rootFolders.mediaType, request.mediaType === "movie" ? "movies" : "series"))
    .get();
  if (!rootFolder) {
    throw new Error(
      `No ${request.mediaType === "movie" ? "movie" : "series"} root folder configured`
    );
  }
  const profile = db.select().from(schema.qualityProfiles).all()[0];
  if (!profile) throw new Error("No quality profile configured");

  let seriesId: number | null = null;
  let movieId: number | null = null;

  if (request.mediaType === "movie") {
    const existing = db
      .select({ id: schema.movies.id })
      .from(schema.movies)
      .where(eq(schema.movies.tmdbId, request.tmdbId))
      .get();
    movieId =
      existing?.id ??
      (
        await addMovie({
          tmdbId: request.tmdbId,
          rootFolderId: rootFolder.id,
          qualityProfileId: profile.id,
          monitored: true,
        })
      ).id;
    enqueueCommand("WantedSearch", { movieId }, "system", 5);
  } else {
    const existing = db
      .select({ id: schema.series.id })
      .from(schema.series)
      .where(eq(schema.series.tmdbId, request.tmdbId))
      .get();
    seriesId =
      existing?.id ??
      (
        await addSeries({
          tmdbId: request.tmdbId,
          rootFolderId: rootFolder.id,
          qualityProfileId: profile.id,
          monitored: true,
        })
      ).id;

    // if specific seasons were requested, monitor only those
    const wantedSeasons = request.seasons as number[] | null;
    if (wantedSeasons && wantedSeasons.length > 0) {
      db.update(schema.seasons)
        .set({ monitored: false })
        .where(eq(schema.seasons.seriesId, seriesId))
        .run();
      db.update(schema.episodes)
        .set({ monitored: false })
        .where(eq(schema.episodes.seriesId, seriesId))
        .run();
      db.update(schema.seasons)
        .set({ monitored: true })
        .where(
          and(
            eq(schema.seasons.seriesId, seriesId),
            inArray(schema.seasons.seasonNumber, wantedSeasons)
          )
        )
        .run();
      db.update(schema.episodes)
        .set({ monitored: true })
        .where(
          and(
            eq(schema.episodes.seriesId, seriesId),
            inArray(schema.episodes.seasonNumber, wantedSeasons)
          )
        )
        .run();
    }
    enqueueCommand("WantedSearch", { seriesId }, "system", 5);
  }

  db.update(schema.requests)
    .set({
      status: "approved",
      decidedByUserId: adminUserId || null,
      decidedAt: new Date(),
      seriesId,
      movieId,
    })
    .where(eq(schema.requests.id, requestId))
    .run();
  emitEvent({ type: "request.updated", requestId });
}

/** Called after an import: flip approved requests to 'available' when their media has files. */
export function markRequestsAvailable(mediaType: "series" | "movie", mediaId: number) {
  const db = getDb();
  const col = mediaType === "movie" ? schema.requests.movieId : schema.requests.seriesId;
  const candidates = db
    .select()
    .from(schema.requests)
    .where(and(eq(schema.requests.status, "approved"), eq(col, mediaId)))
    .all();
  for (const request of candidates) {
    db.update(schema.requests)
      .set({ status: "available" })
      .where(eq(schema.requests.id, request.id))
      .run();
    emitEvent({ type: "request.updated", requestId: request.id });
    // Best-effort Pushover to the requester (no-op unless configured).
    notifyRequestAvailable(request.userId, request.title);
  }
}
