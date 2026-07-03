/**
 * Per-user activity for the admin Users panel: online/offline (from the session
 * heartbeat), what each user is watching right now, what they watched last, and
 * how many requests they've made.
 *
 * "Now streaming" is inferred from watch-progress heartbeats — the player PUTs
 * progress roughly every 15s while playing (for both direct-play and transcode),
 * so a progress row touched within STREAM_WINDOW_MS with playback unfinished means
 * the user is actively watching. No separate session-tracking is needed.
 */
import { desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { posterUrl } from "@/server/metadata/tmdb";

/** A user counts as "online" if their last authenticated activity was within this window. */
export const ONLINE_WINDOW_MS = 5 * 60_000;
/** A watch-progress row touched within this window (and not finished) means "streaming now". */
export const STREAM_WINDOW_MS = 90_000;

export interface MediaView {
  kind: "movie" | "episode";
  title: string;
  subtitle: string | null;
  poster: string | null;
}

export interface NowStreaming extends MediaView {
  progressPct: number;
  positionSeconds: number;
  durationSeconds: number;
  updatedAt: number;
}

export interface LastWatched extends MediaView {
  watched: boolean;
  updatedAt: number;
}

export interface UserActivity {
  id: number;
  username: string;
  role: "admin" | "user";
  createdAt: number;
  lastSeenAt: number | null;
  online: boolean;
  requestCount: number;
  nowStreaming: NowStreaming | null;
  lastWatched: LastWatched | null;
}

type ProgressJoin = {
  userId: number;
  updatedAt: Date;
  positionSeconds: number;
  durationSeconds: number;
  watched: boolean;
  movieTitle: string | null;
  moviePoster: string | null;
  movieYear: number | null;
  seriesTitle: string | null;
  seriesPoster: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
};

function pct(position: number, duration: number): number {
  if (duration <= 0) return 0;
  return Math.min(100, Math.round((position / duration) * 100));
}

/** Resolve the movie/episode a progress row points at into a display view. */
function mediaOf(r: ProgressJoin): MediaView | null {
  if (r.movieTitle != null) {
    return {
      kind: "movie",
      title: r.movieTitle,
      subtitle: r.movieYear ? String(r.movieYear) : null,
      poster: posterUrl(r.moviePoster),
    };
  }
  if (r.seriesTitle != null) {
    const ep =
      r.seasonNumber != null
        ? `S${r.seasonNumber} · E${r.episodeNumber}${r.episodeTitle ? ` · ${r.episodeTitle}` : ""}`
        : null;
    return { kind: "episode", title: r.seriesTitle, subtitle: ep, poster: posterUrl(r.seriesPoster) };
  }
  return null;
}

/** All users with their live activity, admins first then alphabetical. */
export function listUsersWithActivity(now = Date.now()): UserActivity[] {
  const db = getDb();

  const users = db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      role: schema.users.role,
      createdAt: schema.users.createdAt,
      lastSeenAt: schema.users.lastSeenAt,
    })
    .from(schema.users)
    .all();

  // requests-per-user
  const requestCounts = new Map<number, number>(
    db
      .select({ userId: schema.requests.userId, n: sql<number>`count(*)` })
      .from(schema.requests)
      .groupBy(schema.requests.userId)
      .all()
      .map((r) => [r.userId, Number(r.n)])
  );

  // Latest progress row per user (newest first; first seen per user wins).
  const progressRows = db
    .select({
      userId: schema.watchProgress.userId,
      updatedAt: schema.watchProgress.updatedAt,
      positionSeconds: schema.watchProgress.positionSeconds,
      durationSeconds: schema.watchProgress.durationSeconds,
      watched: schema.watchProgress.watched,
      movieTitle: schema.movies.title,
      moviePoster: schema.movies.posterPath,
      movieYear: schema.movies.year,
      seriesTitle: schema.series.title,
      seriesPoster: schema.series.posterPath,
      seasonNumber: schema.episodes.seasonNumber,
      episodeNumber: schema.episodes.episodeNumber,
      episodeTitle: schema.episodes.title,
    })
    .from(schema.watchProgress)
    .leftJoin(schema.movies, eq(schema.movies.id, schema.watchProgress.movieId))
    .leftJoin(schema.episodes, eq(schema.episodes.id, schema.watchProgress.episodeId))
    .leftJoin(schema.series, eq(schema.series.id, schema.watchProgress.seriesId))
    .orderBy(desc(schema.watchProgress.updatedAt))
    .all() as ProgressJoin[];

  const latestByUser = new Map<number, ProgressJoin>();
  for (const r of progressRows) {
    if (!latestByUser.has(r.userId)) latestByUser.set(r.userId, r);
  }

  const out: UserActivity[] = users.map((u) => {
    const latest = latestByUser.get(u.id);
    const media = latest ? mediaOf(latest) : null;
    const updatedAt = latest ? latest.updatedAt.getTime() : 0;

    const nowStreaming: NowStreaming | null =
      latest && media && !latest.watched && now - updatedAt < STREAM_WINDOW_MS
        ? {
            ...media,
            positionSeconds: latest.positionSeconds,
            durationSeconds: latest.durationSeconds,
            progressPct: pct(latest.positionSeconds, latest.durationSeconds),
            updatedAt,
          }
        : null;

    const lastWatched: LastWatched | null =
      latest && media ? { ...media, watched: latest.watched, updatedAt } : null;

    const seenMs = u.lastSeenAt ? u.lastSeenAt.getTime() : null;
    const online = nowStreaming != null || (seenMs != null && now - seenMs < ONLINE_WINDOW_MS);

    return {
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.createdAt.getTime(),
      lastSeenAt: seenMs,
      online,
      requestCount: requestCounts.get(u.id) ?? 0,
      nowStreaming,
      lastWatched,
    };
  });

  return out.sort((a, b) => {
    if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
    return a.username.localeCompare(b.username);
  });
}

export interface ActiveStream {
  userId: number;
  username: string;
  stream: NowStreaming;
}

/** Just the users watching something right now — for the admin dashboard. */
export function getActiveStreams(now = Date.now()): ActiveStream[] {
  return listUsersWithActivity(now)
    .filter((u): u is UserActivity & { nowStreaming: NowStreaming } => u.nowStreaming != null)
    .map((u) => ({ userId: u.id, username: u.username, stream: u.nowStreaming }))
    .sort((a, b) => b.stream.updatedAt - a.stream.updatedAt);
}
