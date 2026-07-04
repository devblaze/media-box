/**
 * Per-user playback progress: resume points, watched flags, and the
 * "continue watching" / "recently watched" feeds.
 */
import { and, asc, desc, eq, gt, gte, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { posterUrl, backdropUrl } from "@/server/metadata/tmdb";

const WATCHED_PCT = 0.9;
// A brand-new resume entry is only created once this much has been watched, so a
// mis-click that opens a title for a couple of seconds doesn't pollute Continue
// Watching. Updates to an existing entry are exempt (you've already started it).
const MIN_RECORD_SECONDS = 10;

export interface ProgressInput {
  movieId?: number | null;
  episodeId?: number | null;
  seriesId?: number | null;
  positionSeconds: number;
  durationSeconds: number;
}

export interface ContinueItem {
  kind: "movie" | "episode";
  title: string;
  subtitle: string | null;
  poster: string | null;
  backdrop: string | null;
  movieId: number | null;
  seriesId: number | null;
  episodeId: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  positionSeconds: number;
  durationSeconds: number;
  progressPct: number;
  watched: boolean;
  updatedAt: number;
}

function pct(position: number, duration: number): number {
  if (duration <= 0) return 0;
  return Math.min(100, Math.round((position / duration) * 100));
}

/** Insert or update the resume point for a movie/episode. */
export function upsertProgress(userId: number, input: ProgressInput): void {
  const db = getDb();
  const now = new Date();
  const watched =
    input.durationSeconds > 0 && input.positionSeconds / input.durationSeconds >= WATCHED_PCT;

  // Derive seriesId for episode progress so "continue watching" can group by series
  // without the caller (the player) having to know it.
  let seriesId = input.seriesId ?? null;
  if (input.episodeId && seriesId == null) {
    seriesId =
      db
        .select({ seriesId: schema.episodes.seriesId })
        .from(schema.episodes)
        .where(eq(schema.episodes.id, input.episodeId))
        .get()?.seriesId ?? null;
  }

  const existing = input.movieId
    ? db
        .select()
        .from(schema.watchProgress)
        .where(and(eq(schema.watchProgress.userId, userId), eq(schema.watchProgress.movieId, input.movieId)))
        .get()
    : input.episodeId
      ? db
          .select()
          .from(schema.watchProgress)
          .where(
            and(eq(schema.watchProgress.userId, userId), eq(schema.watchProgress.episodeId, input.episodeId))
          )
          .get()
      : null;

  if (existing) {
    db.update(schema.watchProgress)
      .set({
        positionSeconds: input.positionSeconds,
        durationSeconds: input.durationSeconds || existing.durationSeconds,
        watched: existing.watched || watched,
        updatedAt: now,
      })
      .where(eq(schema.watchProgress.id, existing.id))
      .run();
    return;
  }

  // No prior entry: only create one once a little has actually been watched, so a
  // brief mis-click never shows up as something to "continue". (`watched` can still
  // be true here — a short title finished — in which case we always record it.)
  if (input.positionSeconds < MIN_RECORD_SECONDS && !watched) return;

  db.insert(schema.watchProgress)
    .values({
      userId,
      movieId: input.movieId ?? null,
      episodeId: input.episodeId ?? null,
      seriesId,
      positionSeconds: input.positionSeconds,
      durationSeconds: input.durationSeconds,
      watched,
      updatedAt: now,
    })
    .run();
}

function markOne(
  userId: number,
  target: { movieId?: number; episodeId?: number; seriesId?: number },
  watched: boolean
): void {
  const db = getDb();
  const now = new Date();
  const existing = target.movieId
    ? db
        .select()
        .from(schema.watchProgress)
        .where(and(eq(schema.watchProgress.userId, userId), eq(schema.watchProgress.movieId, target.movieId)))
        .get()
    : db
        .select()
        .from(schema.watchProgress)
        .where(
          and(eq(schema.watchProgress.userId, userId), eq(schema.watchProgress.episodeId, target.episodeId!))
        )
        .get();

  if (existing) {
    db.update(schema.watchProgress)
      .set({ watched, positionSeconds: watched ? existing.durationSeconds : 0, updatedAt: now })
      .where(eq(schema.watchProgress.id, existing.id))
      .run();
    return;
  }
  db.insert(schema.watchProgress)
    .values({
      userId,
      movieId: target.movieId ?? null,
      episodeId: target.episodeId ?? null,
      seriesId: target.seriesId ?? null,
      positionSeconds: 0,
      durationSeconds: 0,
      watched,
      updatedAt: now,
    })
    .run();
}

/** Mark a movie / episode / whole series watched or unwatched. */
export function setWatched(
  userId: number,
  target: { movieId?: number; episodeId?: number; seriesId?: number },
  watched: boolean
): void {
  const db = getDb();
  if (target.movieId) return markOne(userId, { movieId: target.movieId }, watched);
  if (target.episodeId) {
    const seriesId = db
      .select({ seriesId: schema.episodes.seriesId })
      .from(schema.episodes)
      .where(eq(schema.episodes.id, target.episodeId))
      .get()?.seriesId;
    return markOne(userId, { episodeId: target.episodeId, seriesId: seriesId ?? undefined }, watched);
  }
  if (target.seriesId) {
    const eps = db
      .select({ id: schema.episodes.id })
      .from(schema.episodes)
      .where(and(eq(schema.episodes.seriesId, target.seriesId), isNotNull(schema.episodes.episodeFileId)))
      .all();
    for (const ep of eps) markOne(userId, { episodeId: ep.id, seriesId: target.seriesId }, watched);
  }
}

export function getProgress(
  userId: number,
  target: { movieId?: number; episodeId?: number }
): { positionSeconds: number; durationSeconds: number; watched: boolean } | null {
  const db = getDb();
  const row = target.movieId
    ? db
        .select()
        .from(schema.watchProgress)
        .where(and(eq(schema.watchProgress.userId, userId), eq(schema.watchProgress.movieId, target.movieId)))
        .get()
    : target.episodeId
      ? db
          .select()
          .from(schema.watchProgress)
          .where(
            and(eq(schema.watchProgress.userId, userId), eq(schema.watchProgress.episodeId, target.episodeId))
          )
          .get()
      : null;
  if (!row) return null;
  return {
    positionSeconds: row.positionSeconds,
    durationSeconds: row.durationSeconds,
    watched: row.watched,
  };
}

type MovieRow = typeof schema.movies.$inferSelect;
type SeriesRow = typeof schema.series.$inferSelect;
type EpisodeRow = typeof schema.episodes.$inferSelect;
type ProgressRow = typeof schema.watchProgress.$inferSelect;

function movieItem(movie: MovieRow, prog: ProgressRow): ContinueItem {
  return {
    kind: "movie",
    title: movie.title,
    subtitle: movie.year ? String(movie.year) : null,
    poster: posterUrl(movie.posterPath),
    backdrop: backdropUrl(movie.backdropPath),
    movieId: movie.id,
    seriesId: null,
    episodeId: null,
    seasonNumber: null,
    episodeNumber: null,
    positionSeconds: prog.positionSeconds,
    durationSeconds: prog.durationSeconds,
    progressPct: pct(prog.positionSeconds, prog.durationSeconds),
    watched: prog.watched,
    updatedAt: prog.updatedAt.getTime(),
  };
}

function episodeItem(
  series: SeriesRow,
  ep: EpisodeRow,
  prog: ProgressRow | null,
  activityAt: number
): ContinueItem {
  return {
    kind: "episode",
    title: series.title,
    subtitle: `S${ep.seasonNumber} · E${ep.episodeNumber}${ep.title ? ` · ${ep.title}` : ""}`,
    poster: posterUrl(series.posterPath),
    backdrop: backdropUrl(series.backdropPath),
    movieId: null,
    seriesId: series.id,
    episodeId: ep.id,
    seasonNumber: ep.seasonNumber,
    episodeNumber: ep.episodeNumber,
    positionSeconds: prog?.positionSeconds ?? 0,
    durationSeconds: prog?.durationSeconds ?? 0,
    progressPct: prog ? pct(prog.positionSeconds, prog.durationSeconds) : 0,
    watched: prog?.watched ?? false,
    updatedAt: activityAt,
  };
}

/** The next episode (with a file) after the given coordinates that the user hasn't watched. */
function nextEpisode(
  userId: number,
  seriesId: number,
  afterSeason: number,
  afterEpisode: number
): EpisodeRow | null {
  const db = getDb();
  const watchedIds = new Set(
    db
      .select({ episodeId: schema.watchProgress.episodeId })
      .from(schema.watchProgress)
      .where(and(eq(schema.watchProgress.userId, userId), eq(schema.watchProgress.watched, true)))
      .all()
      .map((r) => r.episodeId)
  );
  const eps = db
    .select()
    .from(schema.episodes)
    .where(
      and(
        eq(schema.episodes.seriesId, seriesId),
        isNotNull(schema.episodes.episodeFileId),
        gt(schema.episodes.seasonNumber, 0)
      )
    )
    .orderBy(asc(schema.episodes.seasonNumber), asc(schema.episodes.episodeNumber))
    .all();
  for (const e of eps) {
    const isAfter =
      e.seasonNumber > afterSeason ||
      (e.seasonNumber === afterSeason && e.episodeNumber > afterEpisode);
    if (isAfter && !watchedIds.has(e.id)) return e;
  }
  return null;
}

/** In-progress movies + the next episode to watch per started series, newest activity first. */
export function continueWatching(userId: number, limit = 20): ContinueItem[] {
  const db = getDb();
  const items: ContinueItem[] = [];

  const movieRows = db
    .select({ prog: schema.watchProgress, movie: schema.movies })
    .from(schema.watchProgress)
    .innerJoin(schema.movies, eq(schema.movies.id, schema.watchProgress.movieId))
    .where(
      and(
        eq(schema.watchProgress.userId, userId),
        eq(schema.watchProgress.watched, false),
        // Ignore barely-started titles (mis-clicks) — see MIN_RECORD_SECONDS.
        gte(schema.watchProgress.positionSeconds, MIN_RECORD_SECONDS)
      )
    )
    .all();
  for (const r of movieRows) items.push(movieItem(r.movie, r.prog));

  const epRows = db
    .select({ prog: schema.watchProgress, ep: schema.episodes, series: schema.series })
    .from(schema.watchProgress)
    .innerJoin(schema.episodes, eq(schema.episodes.id, schema.watchProgress.episodeId))
    .innerJoin(schema.series, eq(schema.series.id, schema.episodes.seriesId))
    .where(and(eq(schema.watchProgress.userId, userId), isNotNull(schema.watchProgress.episodeId)))
    .orderBy(desc(schema.watchProgress.updatedAt))
    .all();
  const seenSeries = new Set<number>();
  for (const r of epRows) {
    if (seenSeries.has(r.series.id)) continue;
    // A barely-opened, unwatched episode (mis-click) shouldn't become the series'
    // resume point and hide the real next-up episode. Skip it and let an older,
    // meaningful row for this series decide instead.
    if (!r.prog.watched && r.prog.positionSeconds < MIN_RECORD_SECONDS) continue;
    seenSeries.add(r.series.id);
    const activityAt = r.prog.updatedAt.getTime();
    if (!r.prog.watched && r.prog.positionSeconds > 0) {
      items.push(episodeItem(r.series, r.ep, r.prog, activityAt));
    } else {
      const next = nextEpisode(userId, r.series.id, r.ep.seasonNumber, r.ep.episodeNumber);
      if (next) items.push(episodeItem(r.series, next, null, activityAt));
    }
  }

  return items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** Recently finished movies + episodes (watched), newest first, one entry per series. */
export function recentlyWatched(userId: number, limit = 20): ContinueItem[] {
  const db = getDb();
  const items: ContinueItem[] = [];

  const movieRows = db
    .select({ prog: schema.watchProgress, movie: schema.movies })
    .from(schema.watchProgress)
    .innerJoin(schema.movies, eq(schema.movies.id, schema.watchProgress.movieId))
    .where(and(eq(schema.watchProgress.userId, userId), eq(schema.watchProgress.watched, true)))
    .all();
  for (const r of movieRows) items.push(movieItem(r.movie, r.prog));

  const epRows = db
    .select({ prog: schema.watchProgress, ep: schema.episodes, series: schema.series })
    .from(schema.watchProgress)
    .innerJoin(schema.episodes, eq(schema.episodes.id, schema.watchProgress.episodeId))
    .innerJoin(schema.series, eq(schema.series.id, schema.episodes.seriesId))
    .where(and(eq(schema.watchProgress.userId, userId), eq(schema.watchProgress.watched, true)))
    .orderBy(desc(schema.watchProgress.updatedAt))
    .all();
  const seenSeries = new Set<number>();
  for (const r of epRows) {
    if (seenSeries.has(r.series.id)) continue;
    seenSeries.add(r.series.id);
    items.push(episodeItem(r.series, r.ep, r.prog, r.prog.updatedAt.getTime()));
  }

  return items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

// ---------- Series-level smart resume (for the detail-page Play button) ----------

export interface SeriesResumeEp {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
}

export interface SeriesResume {
  hasStarted: boolean;
  /** resume = continue; start = play the first (true first) available; start-from-available =
   *  earliest aired episodes are missing so start from the first we have; unavailable = nothing to play. */
  action: "resume" | "start" | "start-from-available" | "unavailable";
  episode: SeriesResumeEp | null; // the episode Play should open
  resumeSeconds: number; // >0 only when resuming mid-episode
  firstAvailable: SeriesResumeEp | null;
  /** Aired episodes with no file that come before firstAvailable (e.g. a missing S01E01). */
  missingBefore: { seasonNumber: number; episodeNumber: number }[];
}

/**
 * Decide what a series-level Play button should do for this user: continue where
 * they left off, start from the first available episode, or — when the earliest
 * aired episodes aren't downloaded — start from the first one we have while
 * reporting the missing ones so the UI can offer to search + wait for them.
 */
export function seriesResume(userId: number, seriesId: number): SeriesResume {
  const db = getDb();
  const now = new Date();

  const eps = db
    .select({
      id: schema.episodes.id,
      seasonNumber: schema.episodes.seasonNumber,
      episodeNumber: schema.episodes.episodeNumber,
      title: schema.episodes.title,
      episodeFileId: schema.episodes.episodeFileId,
      airDateUtc: schema.episodes.airDateUtc,
    })
    .from(schema.episodes)
    .where(and(eq(schema.episodes.seriesId, seriesId), gt(schema.episodes.seasonNumber, 0)))
    .orderBy(asc(schema.episodes.seasonNumber), asc(schema.episodes.episodeNumber))
    .all();

  const firstAvailable = eps.find((e) => e.episodeFileId != null) ?? null;
  const isBefore = (e: (typeof eps)[number]) =>
    !firstAvailable ||
    e.seasonNumber < firstAvailable.seasonNumber ||
    (e.seasonNumber === firstAvailable.seasonNumber && e.episodeNumber < firstAvailable.episodeNumber);
  const missingBefore = eps
    .filter((e) => e.episodeFileId == null && e.airDateUtc != null && e.airDateUtc <= now && isBefore(e))
    .map((e) => ({ seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber }));

  const slim = (
    e: { id: number; seasonNumber: number; episodeNumber: number; title: string | null } | null | undefined
  ): SeriesResumeEp | null =>
    e ? { id: e.id, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, title: e.title } : null;

  const prog = db
    .select({
      episodeId: schema.watchProgress.episodeId,
      positionSeconds: schema.watchProgress.positionSeconds,
      watched: schema.watchProgress.watched,
      updatedAt: schema.watchProgress.updatedAt,
    })
    .from(schema.watchProgress)
    .innerJoin(schema.episodes, eq(schema.watchProgress.episodeId, schema.episodes.id))
    .where(and(eq(schema.watchProgress.userId, userId), eq(schema.episodes.seriesId, seriesId)))
    .all();
  const hasStarted = prog.length > 0;

  if (hasStarted) {
    const latest = [...prog].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    const latestEp = eps.find((e) => e.id === latest.episodeId) ?? null;
    if (latestEp?.episodeFileId != null && !latest.watched && latest.positionSeconds > 0) {
      return { hasStarted, action: "resume", episode: slim(latestEp), resumeSeconds: latest.positionSeconds, firstAvailable: slim(firstAvailable), missingBefore };
    }
    const next = nextEpisode(userId, seriesId, latestEp?.seasonNumber ?? 0, latestEp?.episodeNumber ?? 0);
    if (next) {
      return { hasStarted, action: "resume", episode: slim(next), resumeSeconds: 0, firstAvailable: slim(firstAvailable), missingBefore };
    }
    return { hasStarted, action: firstAvailable ? "start" : "unavailable", episode: slim(firstAvailable), resumeSeconds: 0, firstAvailable: slim(firstAvailable), missingBefore };
  }

  if (!firstAvailable) {
    return { hasStarted: false, action: "unavailable", episode: null, resumeSeconds: 0, firstAvailable: null, missingBefore };
  }
  return {
    hasStarted: false,
    action: missingBefore.length > 0 ? "start-from-available" : "start",
    episode: slim(firstAvailable),
    resumeSeconds: 0,
    firstAvailable: slim(firstAvailable),
    missingBefore,
  };
}
