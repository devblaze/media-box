import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { upsertProgress, setWatched } from "@/server/playback/watch-progress-service";
import { findByTvdbId } from "@/server/metadata/tmdb";
import { recordLog } from "@/server/logging/logger";
import { emitEvent } from "@/server/events/bus";
import {
  getResumeItems,
  getNextUp,
  getItem,
  getSeriesEpisodes,
  providerId,
  ticksToSeconds,
  type JellyfinConnection,
  type JellyfinItem,
} from "./jellyfin-client";
import { connectionFor, getAllLinks, getJellyfinUrl, getLink, recordSyncResult } from "./jellyfin-service";

export interface SyncResult {
  moviesSynced: number;
  episodesSynced: number;
  seriesMatched: number;
  /** Resume/next-up titles that aren't in the media-box library. */
  skipped: number;
}

/** The user's Jellyfin watch state for one item, normalized to seconds. */
interface JfState {
  played: boolean;
  positionSeconds: number;
  durationSeconds: number;
  lastPlayed: Date | null;
}

function stateOf(item: JellyfinItem): JfState {
  const ud = item.UserData;
  return {
    played: ud?.Played ?? false,
    positionSeconds: ticksToSeconds(ud?.PlaybackPositionTicks),
    durationSeconds: ticksToSeconds(item.RunTimeTicks),
    lastPlayed: ud?.LastPlayedDate ? new Date(ud.LastPlayedDate) : null,
  };
}

/**
 * Apply one Jellyfin item's state to a local watch_progress target, unless the
 * local row is at least as recent — media-box's own player progress must never
 * be clobbered by an older Jellyfin session. Returns true when a write happened.
 */
function applyState(
  userId: number,
  target: { movieId?: number; episodeId?: number },
  jf: JfState
): boolean {
  const db = getDb();
  const existing = target.movieId
    ? db
        .select({ updatedAt: schema.watchProgress.updatedAt, watched: schema.watchProgress.watched })
        .from(schema.watchProgress)
        .where(
          and(
            eq(schema.watchProgress.userId, userId),
            eq(schema.watchProgress.movieId, target.movieId)
          )
        )
        .get()
    : db
        .select({ updatedAt: schema.watchProgress.updatedAt, watched: schema.watchProgress.watched })
        .from(schema.watchProgress)
        .where(
          and(
            eq(schema.watchProgress.userId, userId),
            eq(schema.watchProgress.episodeId, target.episodeId!)
          )
        )
        .get();

  if (existing) {
    // Without a LastPlayedDate there is no way to order the two states — keep local.
    if (!jf.lastPlayed || existing.updatedAt >= jf.lastPlayed) return false;
    if (existing.watched && jf.played) return false; // both agree; nothing to write
  }

  if (jf.played) {
    setWatched(userId, target, true);
    return true;
  }
  if (jf.positionSeconds > 0) {
    upsertProgress(userId, {
      movieId: target.movieId ?? null,
      episodeId: target.episodeId ?? null,
      positionSeconds: jf.positionSeconds,
      durationSeconds: jf.durationSeconds,
    });
    return true;
  }
  return false;
}

function findMovieId(item: JellyfinItem): number | null {
  const db = getDb();
  const tmdb = providerId(item, "Tmdb");
  if (tmdb && /^\d+$/.test(tmdb)) {
    const row = db
      .select({ id: schema.movies.id })
      .from(schema.movies)
      .where(eq(schema.movies.tmdbId, Number(tmdb)))
      .get();
    if (row) return row.id;
  }
  const imdb = providerId(item, "Imdb");
  if (imdb) {
    const row = db
      .select({ id: schema.movies.id })
      .from(schema.movies)
      .where(eq(schema.movies.imdbId, imdb))
      .get();
    if (row) return row.id;
  }
  return null;
}

/** Match a Jellyfin series to a library series via Tmdb → Tvdb → Imdb ids. */
async function findSeriesId(seriesItem: JellyfinItem): Promise<number | null> {
  const db = getDb();
  const tmdb = providerId(seriesItem, "Tmdb");
  if (tmdb && /^\d+$/.test(tmdb)) {
    const row = db
      .select({ id: schema.series.id })
      .from(schema.series)
      .where(eq(schema.series.tmdbId, Number(tmdb)))
      .get();
    if (row) return row.id;
  }
  const tvdb = providerId(seriesItem, "Tvdb");
  if (tvdb && /^\d+$/.test(tvdb)) {
    const row = db
      .select({ id: schema.series.id })
      .from(schema.series)
      .where(eq(schema.series.tvdbId, Number(tvdb)))
      .get();
    if (row) return row.id;
    // Library rows added natively may lack a tvdbId — resolve tvdb→tmdb via TMDB.
    try {
      const found = await findByTvdbId(Number(tvdb));
      const tmdbId = found.tv_results[0]?.id;
      if (tmdbId) {
        const byTmdb = db
          .select({ id: schema.series.id })
          .from(schema.series)
          .where(eq(schema.series.tmdbId, tmdbId))
          .get();
        if (byTmdb) return byTmdb.id;
      }
    } catch {
      // TMDB hiccup — fall through to imdb
    }
  }
  const imdb = providerId(seriesItem, "Imdb");
  if (imdb) {
    const row = db
      .select({ id: schema.series.id })
      .from(schema.series)
      .where(eq(schema.series.imdbId, imdb))
      .get();
    if (row) return row.id;
  }
  return null;
}

function findEpisodeId(seriesId: number, season: number, episode: number): number | null {
  return (
    getDb()
      .select({ id: schema.episodes.id })
      .from(schema.episodes)
      .where(
        and(
          eq(schema.episodes.seriesId, seriesId),
          eq(schema.episodes.seasonNumber, season),
          eq(schema.episodes.episodeNumber, episode)
        )
      )
      .get()?.id ?? null
  );
}

/**
 * Pull the user's Continue Watching + Next Up from Jellyfin and mirror them into
 * watch_progress. For every series the user is actively watching, the full
 * per-episode watch state is synced (that history is exactly what makes
 * media-box's own continue-watching surface the same next episode).
 */
export async function syncUser(userId: number): Promise<SyncResult> {
  const link = getLink(userId);
  if (!link) throw new Error("No Jellyfin account linked");
  const url = getJellyfinUrl();
  if (!url) throw new Error("No Jellyfin server configured");
  const conn = connectionFor(link, url);

  const result: SyncResult = { moviesSynced: 0, episodesSynced: 0, seriesMatched: 0, skipped: 0 };
  try {
    const [resume, nextUp] = await Promise.all([getResumeItems(conn), getNextUp(conn)]);
    const items = [...(resume.Items ?? []), ...(nextUp.Items ?? [])];

    // Movies: resume items map straight onto library movies.
    for (const item of items) {
      if (item.Type !== "Movie") continue;
      const movieId = findMovieId(item);
      if (movieId == null) {
        result.skipped++;
        continue;
      }
      if (applyState(userId, { movieId }, stateOf(item))) result.moviesSynced++;
    }

    // Series: every distinct series behind a resume/next-up episode.
    const seriesIds = [
      ...new Set(items.filter((i) => i.Type === "Episode" && i.SeriesId).map((i) => i.SeriesId!)),
    ];
    for (const jfSeriesId of seriesIds) {
      const seriesItem = await getItem(conn, jfSeriesId);
      const localSeriesId = await findSeriesId(seriesItem);
      if (localSeriesId == null) {
        result.skipped++;
        continue;
      }
      result.seriesMatched++;
      const episodes = (await getSeriesEpisodes(conn, jfSeriesId)).Items ?? [];
      for (const ep of episodes) {
        const state = stateOf(ep);
        if (!state.played && state.positionSeconds === 0) continue; // untouched
        if (ep.ParentIndexNumber == null || ep.IndexNumber == null) continue;
        const episodeId = findEpisodeId(localSeriesId, ep.ParentIndexNumber, ep.IndexNumber);
        if (episodeId == null) continue;
        if (applyState(userId, { episodeId }, state)) result.episodesSynced++;
      }
    }

    recordSyncResult(userId, null);
    emitEvent({ type: "jellyfin.synced", targetUserId: userId });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSyncResult(userId, message);
    throw err;
  }
}

/** Sync every linked user; one user's failure never blocks the rest. */
export async function syncAllUsers(): Promise<string> {
  const links = getAllLinks();
  if (links.length === 0) return "no linked Jellyfin accounts";
  if (!getJellyfinUrl()) return "no Jellyfin server configured";
  let synced = 0;
  let failed = 0;
  for (const link of links) {
    try {
      await syncUser(link.userId);
      synced++;
    } catch (err) {
      failed++;
      recordLog(
        "warn",
        `Jellyfin sync failed for user ${link.userId}: ${err instanceof Error ? err.message : String(err)}`,
        { source: "jellyfin" }
      );
    }
  }
  return `synced ${synced} of ${links.length} linked account${links.length === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}`;
}
