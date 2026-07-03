import { and, asc, desc, eq, isNotNull, lt } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { searchReleases } from "@/server/indexers/release-search";
import { episodeTarget, movieTarget } from "@/server/indexers/search-targets";
import { grab } from "@/server/download/download-service";
import type { MediaInfo } from "@/server/library/media-info";
import { type Channel, CHANNELS, isChannel } from "@/lib/channels";

export { type Channel, CHANNELS, isChannel };

// ---------------------------------------------------------------------------
// Live TV channel scheduler
//
// Each channel (movies / series / anime) is a synchronized broadcast station.
// Its program lineup is MATERIALIZED into `channel_programs` on a rolling ~12h
// horizon, laid end-to-end on the wall clock (each program's startAt = the
// previous program's endAt). "Now playing" is therefore the program whose
// [startAt, endAt) window contains the current instant, at offset now - startAt.
//
// Because the schedule is precomputed, (a) every viewer who tunes in sees the
// same title at the same moment, (b) it keeps "airing" whether or not anyone is
// watching, and (c) the same rows double as the TV Guide ("coming up next").
//
// Ordering is preserved across occurrences via `channel_progress` cursors: a
// series remembers its last-scheduled episode, a franchise its last-scheduled
// part. When the next-in-order item is missing on disk we (optionally) kick off
// a background grab and skip to the next available item so the channel never
// stalls — the grabbed item lands for a future cycle.
// ---------------------------------------------------------------------------

/** Keep the schedule filled this far ahead so the guide has depth. */
const HORIZON_MS = 12 * 60 * 60 * 1000;
/** Delete programs that ended more than this long ago. */
const PRUNE_GRACE_MS = 60 * 60 * 1000;
/** Don't repeat a show/movie that appears within the last N scheduled programs. */
const RECENT_WINDOW = 6;
/** Fallbacks when neither media info nor runtime is known. */
const DEFAULT_EPISODE_SECONDS = 30 * 60;
const DEFAULT_MOVIE_SECONDS = 90 * 60;
/** Guard against zero/absurd durations spinning the materialize loop. */
const MIN_PROGRAM_SECONDS = 5 * 60;
/** Hard cap on programs appended per materialize pass (loop backstop). */
const MAX_APPEND_PER_PASS = 300;
/** Probability of continuing an in-progress franchise vs. starting fresh. */
const FRANCHISE_CONTINUE_CHANCE = 0.7;

export interface ScheduleOptions {
  /**
   * Fire background downloads for missing next-in-order items. Defaults on:
   * grabs only happen when the schedule actually extends (the buffer drained),
   * so their rate tracks real-time schedule advance — never read frequency —
   * and each item is de-duped against active downloads.
   */
  allowGrab?: boolean;
}

interface ProgramCandidate {
  mediaType: "movie" | "episode";
  movieId?: number;
  episodeId?: number;
  title: string;
  durationSeconds: number;
}

// ---------- small utilities ----------

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function episodeCode(season: number, episode: number): string {
  return `S${pad2(season)}E${pad2(episode)}`;
}

/** durationSec from probed media info, else runtime (minutes), else a fallback. */
function durationFrom(
  mediaInfo: unknown,
  runtimeMinutes: number | null | undefined,
  fallbackSeconds: number
): number {
  const probed = (mediaInfo as { durationSec?: number | null } | null)?.durationSec;
  if (typeof probed === "number" && probed >= MIN_PROGRAM_SECONDS) return Math.round(probed);
  if (runtimeMinutes && runtimeMinutes > 0) return Math.max(MIN_PROGRAM_SECONDS, runtimeMinutes * 60);
  return fallbackSeconds;
}

// ---------- cursor helpers ----------

function getCursor(channel: Channel, refKind: "series" | "collection", refId: number) {
  return getDb()
    .select()
    .from(schema.channelProgress)
    .where(
      and(
        eq(schema.channelProgress.channel, channel),
        eq(schema.channelProgress.refKind, refKind),
        eq(schema.channelProgress.refId, refId)
      )
    )
    .get();
}

function setCursor(
  channel: Channel,
  refKind: "series" | "collection",
  refId: number,
  values: { lastEpisodeId?: number | null; lastMovieId?: number | null }
) {
  const now = new Date();
  getDb()
    .insert(schema.channelProgress)
    .values({
      channel,
      refKind,
      refId,
      lastEpisodeId: values.lastEpisodeId ?? null,
      lastMovieId: values.lastMovieId ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.channelProgress.channel,
        schema.channelProgress.refKind,
        schema.channelProgress.refId,
      ],
      set: { ...values, updatedAt: now },
    })
    .run();
}

/** series/movie ids appearing in the last N scheduled programs (adjacency guard). */
function recentlyPlayed(channel: Channel): { seriesIds: Set<number>; movieIds: Set<number> } {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.channelPrograms)
    .where(eq(schema.channelPrograms.channel, channel))
    .orderBy(desc(schema.channelPrograms.startAt))
    .limit(RECENT_WINDOW)
    .all();
  const seriesIds = new Set<number>();
  const movieIds = new Set<number>();
  for (const r of rows) {
    if (r.movieId) movieIds.add(r.movieId);
    if (r.episodeId) {
      const ep = db
        .select({ seriesId: schema.episodes.seriesId })
        .from(schema.episodes)
        .where(eq(schema.episodes.id, r.episodeId))
        .get();
      if (ep) seriesIds.add(ep.seriesId);
    }
  }
  return { seriesIds, movieIds };
}

// ---------- background acquisition (fire-and-forget) ----------

/** True if an active (not failed/imported) download already covers this episode. */
function hasActiveEpisodeDownload(seriesId: number, episodeId: number): boolean {
  const rows = getDb()
    .select({ episodeIds: schema.downloads.episodeIds, status: schema.downloads.status })
    .from(schema.downloads)
    .where(eq(schema.downloads.seriesId, seriesId))
    .all();
  return rows.some(
    (r) =>
      r.status !== "imported" &&
      r.status !== "failed" &&
      Array.isArray(r.episodeIds) &&
      (r.episodeIds as number[]).includes(episodeId)
  );
}

function hasActiveMovieDownload(movieId: number): boolean {
  const rows = getDb()
    .select({ status: schema.downloads.status })
    .from(schema.downloads)
    .where(eq(schema.downloads.movieId, movieId))
    .all();
  return rows.some((r) => r.status !== "imported" && r.status !== "failed");
}

async function grabMissingEpisode(seriesId: number, episodeId: number): Promise<void> {
  try {
    if (hasActiveEpisodeDownload(seriesId, episodeId)) return;
    const { search, grab: grabTarget } = episodeTarget(episodeId, false);
    const releases = await searchReleases(search);
    const best = releases.find((r) => r.accepted);
    if (best) await grab(best, grabTarget);
  } catch (err) {
    console.warn(`[channels] auto-grab episode ${episodeId} failed:`, err);
  }
}

async function grabMissingMovie(movieId: number): Promise<void> {
  try {
    if (hasActiveMovieDownload(movieId)) return;
    const { search, grab: grabTarget } = movieTarget(movieId, false);
    const releases = await searchReleases(search);
    const best = releases.find((r) => r.accepted);
    if (best) await grab(best, grabTarget);
  } catch (err) {
    console.warn(`[channels] auto-grab movie ${movieId} failed:`, err);
  }
}

// ---------- series / anime program selection ----------

type EpisodeRow = typeof schema.episodes.$inferSelect;
type SeriesRow = typeof schema.series.$inferSelect;

function orderedEpisodes(seriesId: number): EpisodeRow[] {
  return getDb()
    .select()
    .from(schema.episodes)
    .where(eq(schema.episodes.seriesId, seriesId))
    .orderBy(asc(schema.episodes.seasonNumber), asc(schema.episodes.episodeNumber))
    .all();
}

/**
 * The next episode to broadcast for a series, starting after `lastEpisodeId` in
 * (season, episode) order. Available episodes are returned as-is; missing ones
 * are optionally grabbed in the background and skipped. When the run is
 * exhausted it wraps to the first available episode (reruns).
 */
function nextAvailableEpisode(
  series: SeriesRow,
  lastEpisodeId: number | null,
  allowGrab: boolean
): EpisodeRow | null {
  const eps = orderedEpisodes(series.id);
  if (eps.length === 0) return null;

  const lastIdx = lastEpisodeId ? eps.findIndex((e) => e.id === lastEpisodeId) : -1;
  const startIdx = lastIdx >= 0 ? lastIdx + 1 : 0;

  // Forward from the cursor to the end.
  for (let i = startIdx; i < eps.length; i++) {
    if (eps[i].episodeFileId) return eps[i];
    if (allowGrab) void grabMissingEpisode(series.id, eps[i].id);
  }
  // Wrap around (rerun / pick up an episode that became available earlier).
  for (let i = 0; i < startIdx && i < eps.length; i++) {
    if (eps[i].episodeFileId) return eps[i];
  }
  return null;
}

function pickNextEpisodeProgram(channel: Channel, allowGrab: boolean): ProgramCandidate | null {
  const db = getDb();
  const isAnime = channel === "anime";

  const candidates = db
    .select()
    .from(schema.series)
    .where(and(eq(schema.series.isAnime, isAnime), eq(schema.series.monitored, true)))
    .all()
    .filter((s) =>
      db
        .select({ id: schema.episodes.id })
        .from(schema.episodes)
        .where(and(eq(schema.episodes.seriesId, s.id), isNotNull(schema.episodes.episodeFileId)))
        .get()
    );
  if (candidates.length === 0) return null;

  const { seriesIds: recent } = recentlyPlayed(channel);
  const pool = candidates.filter((s) => !recent.has(s.id));
  const series = pickRandom(pool.length > 0 ? pool : candidates);

  const cursor = getCursor(channel, "series", series.id);
  const ep = nextAvailableEpisode(series, cursor?.lastEpisodeId ?? null, allowGrab);
  if (!ep) return null;

  setCursor(channel, "series", series.id, { lastEpisodeId: ep.id });

  const code = episodeCode(ep.seasonNumber, ep.episodeNumber);
  const title = `${series.title} · ${code}${ep.title ? ` — ${ep.title}` : ""}`;
  return {
    mediaType: "episode",
    episodeId: ep.id,
    title,
    durationSeconds: durationFrom(episodeMediaInfo(ep), ep.runtime ?? series.runtime, DEFAULT_EPISODE_SECONDS),
  };
}

function episodeMediaInfo(ep: EpisodeRow): unknown {
  if (!ep.episodeFileId) return null;
  return (
    getDb()
      .select({ mediaInfo: schema.episodeFiles.mediaInfo })
      .from(schema.episodeFiles)
      .where(eq(schema.episodeFiles.id, ep.episodeFileId))
      .get()?.mediaInfo ?? null
  );
}

// ---------- movie / franchise program selection ----------

type MovieRow = typeof schema.movies.$inferSelect;

/** Library movies in a franchise, ordered by release year then title. */
function franchiseParts(collectionTmdbId: number): MovieRow[] {
  return getDb()
    .select()
    .from(schema.movies)
    .where(eq(schema.movies.collectionTmdbId, collectionTmdbId))
    .all()
    .sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity) || a.sortTitle.localeCompare(b.sortTitle));
}

/** Next available part in a franchise after `lastMovieId` (grabs+skips missing). */
function nextFranchisePart(
  parts: MovieRow[],
  lastMovieId: number | null,
  allowGrab: boolean
): MovieRow | null {
  const lastIdx = lastMovieId ? parts.findIndex((m) => m.id === lastMovieId) : -1;
  for (let i = lastIdx + 1; i < parts.length; i++) {
    if (parts[i].movieFileId) return parts[i];
    if (allowGrab) void grabMissingMovie(parts[i].id);
  }
  return null;
}

/** Earliest available part in a franchise (starting a fresh run; grabs missing). */
function firstFranchisePart(parts: MovieRow[], allowGrab: boolean): MovieRow | null {
  for (const p of parts) {
    if (p.movieFileId) return p;
    if (allowGrab) void grabMissingMovie(p.id);
  }
  return null;
}

function movieCandidate(m: MovieRow): ProgramCandidate {
  const mediaInfo = m.movieFileId
    ? (getDb()
        .select({ mediaInfo: schema.movieFiles.mediaInfo })
        .from(schema.movieFiles)
        .where(eq(schema.movieFiles.id, m.movieFileId))
        .get()?.mediaInfo ?? null)
    : null;
  return {
    mediaType: "movie",
    movieId: m.id,
    title: m.year ? `${m.title} (${m.year})` : m.title,
    durationSeconds: durationFrom(mediaInfo, m.runtime, DEFAULT_MOVIE_SECONDS),
  };
}

function pickNextMovieProgram(allowGrab: boolean): ProgramCandidate | null {
  const db = getDb();
  const allMovies = db.select().from(schema.movies).all();
  const available = allMovies.filter((m) => m.movieFileId);
  if (available.length === 0) return null;

  // Franchises = collections with >= 2 library movies.
  const byCollection = new Map<number, MovieRow[]>();
  for (const m of allMovies) {
    if (m.collectionTmdbId == null) continue;
    const list = byCollection.get(m.collectionTmdbId) ?? [];
    list.push(m);
    byCollection.set(m.collectionTmdbId, list);
  }
  const franchiseIds = new Set(
    [...byCollection.entries()].filter(([, list]) => list.length >= 2).map(([cid]) => cid)
  );

  // (A) Prefer continuing an in-progress franchise so sequels chain in order.
  const cursors = db
    .select()
    .from(schema.channelProgress)
    .where(and(eq(schema.channelProgress.channel, "movies"), eq(schema.channelProgress.refKind, "collection")))
    .all();
  const inProgress: { collectionId: number; part: MovieRow }[] = [];
  for (const c of cursors) {
    if (!franchiseIds.has(c.refId)) continue;
    const parts = franchiseParts(c.refId);
    const part = nextFranchisePart(parts, c.lastMovieId ?? null, allowGrab);
    if (part) inProgress.push({ collectionId: c.refId, part });
  }
  if (inProgress.length > 0 && Math.random() < FRANCHISE_CONTINUE_CHANCE) {
    const chosen = pickRandom(inProgress);
    setCursor("movies", "collection", chosen.collectionId, { lastMovieId: chosen.part.id });
    return movieCandidate(chosen.part);
  }

  // (B) Fresh pick — a random not-recently-played available movie.
  const { movieIds: recent } = recentlyPlayed("movies");
  const pool = available.filter((m) => !recent.has(m.id));
  const movie = pickRandom(pool.length > 0 ? pool : available);

  // If it belongs to a franchise, start that franchise from its earliest part.
  if (movie.collectionTmdbId != null && franchiseIds.has(movie.collectionTmdbId)) {
    const parts = franchiseParts(movie.collectionTmdbId);
    const first = firstFranchisePart(parts, allowGrab) ?? movie;
    setCursor("movies", "collection", movie.collectionTmdbId, { lastMovieId: first.id });
    return movieCandidate(first);
  }

  return movieCandidate(movie);
}

function pickNext(channel: Channel, allowGrab: boolean): ProgramCandidate | null {
  return channel === "movies"
    ? pickNextMovieProgram(allowGrab)
    : pickNextEpisodeProgram(channel, allowGrab);
}

// ---------- materialization ----------

/**
 * Prune stale programs and append new ones until the channel's schedule reaches
 * ~HORIZON_MS ahead of now. Safe to call from both the periodic job (allowGrab
 * true) and lazily from the read path (allowGrab false). Synchronous end to end
 * — the only async work (background grabs) is fire-and-forget.
 */
export function ensureChannelSchedule(channel: Channel, opts: ScheduleOptions = {}): void {
  const db = getDb();
  const allowGrab = opts.allowGrab ?? true;
  const now = new Date();

  db.delete(schema.channelPrograms)
    .where(
      and(
        eq(schema.channelPrograms.channel, channel),
        lt(schema.channelPrograms.endAt, new Date(now.getTime() - PRUNE_GRACE_MS))
      )
    )
    .run();

  const tail = db
    .select({ endAt: schema.channelPrograms.endAt })
    .from(schema.channelPrograms)
    .where(eq(schema.channelPrograms.channel, channel))
    .orderBy(desc(schema.channelPrograms.startAt))
    .limit(1)
    .get();

  let cursorMs = tail && tail.endAt.getTime() > now.getTime() ? tail.endAt.getTime() : now.getTime();
  const horizonMs = now.getTime() + HORIZON_MS;

  for (let i = 0; cursorMs < horizonMs && i < MAX_APPEND_PER_PASS; i++) {
    const cand = pickNext(channel, allowGrab);
    if (!cand) break; // channel has no playable content
    const startAt = new Date(cursorMs);
    const endAt = new Date(cursorMs + cand.durationSeconds * 1000);
    db.insert(schema.channelPrograms)
      .values({
        channel,
        mediaType: cand.mediaType,
        movieId: cand.movieId ?? null,
        episodeId: cand.episodeId ?? null,
        title: cand.title,
        startAt,
        endAt,
        durationSeconds: cand.durationSeconds,
      })
      .run();
    cursorMs = endAt.getTime();
  }
}

// ---------- read model (now playing / guide) ----------

export interface ChannelProgram {
  programId: number;
  target: { type: "movie" | "episode"; id: number };
  title: string;
  seriesTitle: string | null;
  episodeLabel: string | null;
  subtitle: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  startAt: number; // epoch ms
  endAt: number; // epoch ms
  durationSeconds: number;
  offsetSeconds: number; // seek offset for the *current* program (0 otherwise)
  mediaInfo: MediaInfo | null;
}

export interface ChannelNow {
  channel: Channel;
  serverNow: number;
  current: ChannelProgram | null;
  upNext: ChannelProgram[];
}

type ProgramRow = typeof schema.channelPrograms.$inferSelect;

/** Resolve a scheduled row to a playable program; null if its file is gone. */
function resolveProgram(row: ProgramRow, nowMs: number): ChannelProgram | null {
  const db = getDb();
  const startMs = row.startAt.getTime();
  const endMs = row.endAt.getTime();
  const offsetSeconds =
    nowMs >= startMs && nowMs < endMs ? Math.max(0, Math.floor((nowMs - startMs) / 1000)) : 0;

  if (row.mediaType === "episode" && row.episodeId) {
    const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId)).get();
    if (!ep || !ep.episodeFileId) return null;
    const series = db.select().from(schema.series).where(eq(schema.series.id, ep.seriesId)).get();
    if (!series) return null;
    const file = db
      .select({ mediaInfo: schema.episodeFiles.mediaInfo })
      .from(schema.episodeFiles)
      .where(eq(schema.episodeFiles.id, ep.episodeFileId))
      .get();
    return {
      programId: row.id,
      target: { type: "episode", id: ep.id },
      title: row.title,
      seriesTitle: series.title,
      episodeLabel: episodeCode(ep.seasonNumber, ep.episodeNumber),
      subtitle: ep.title ?? null,
      posterPath: series.posterPath,
      backdropPath: series.backdropPath,
      startAt: startMs,
      endAt: endMs,
      durationSeconds: row.durationSeconds,
      offsetSeconds,
      mediaInfo: (file?.mediaInfo as MediaInfo | null) ?? null,
    };
  }

  if (row.mediaType === "movie" && row.movieId) {
    const movie = db.select().from(schema.movies).where(eq(schema.movies.id, row.movieId)).get();
    if (!movie || !movie.movieFileId) return null;
    const file = db
      .select({ mediaInfo: schema.movieFiles.mediaInfo })
      .from(schema.movieFiles)
      .where(eq(schema.movieFiles.id, movie.movieFileId))
      .get();
    return {
      programId: row.id,
      target: { type: "movie", id: movie.id },
      title: row.title,
      seriesTitle: null,
      episodeLabel: null,
      subtitle: movie.collectionName,
      posterPath: movie.posterPath,
      backdropPath: movie.backdropPath,
      startAt: startMs,
      endAt: endMs,
      durationSeconds: row.durationSeconds,
      offsetSeconds,
      mediaInfo: (file?.mediaInfo as MediaInfo | null) ?? null,
    };
  }

  return null;
}

function resolvedTimeline(channel: Channel, nowMs: number): ChannelProgram[] {
  return getDb()
    .select()
    .from(schema.channelPrograms)
    .where(eq(schema.channelPrograms.channel, channel))
    .orderBy(asc(schema.channelPrograms.startAt))
    .all()
    .map((r) => resolveProgram(r, nowMs))
    .filter((p): p is ChannelProgram => p !== null);
}

/** The program on now (+ its seek offset) and the next few, materializing first. */
export function getNowAndNext(channel: Channel, upNextCount = 5, opts: ScheduleOptions = {}): ChannelNow {
  ensureChannelSchedule(channel, opts);
  const nowMs = Date.now();
  const timeline = resolvedTimeline(channel, nowMs);

  let currentIdx = timeline.findIndex((p) => nowMs >= p.startAt && nowMs < p.endAt);
  if (currentIdx === -1) currentIdx = timeline.findIndex((p) => p.startAt > nowMs); // gap → next up

  const current = currentIdx >= 0 ? timeline[currentIdx] : null;
  const upNext = currentIdx >= 0 ? timeline.slice(currentIdx + 1, currentIdx + 1 + upNextCount) : [];
  return { channel, serverNow: nowMs, current, upNext };
}

/** The full forward-looking lineup for the TV Guide (current + upcoming). */
export function getGuide(channel: Channel, limit = 40, opts: ScheduleOptions = {}): {
  channel: Channel;
  serverNow: number;
  programs: ChannelProgram[];
} {
  ensureChannelSchedule(channel, opts);
  const nowMs = Date.now();
  const programs = resolvedTimeline(channel, nowMs)
    .filter((p) => p.endAt > nowMs)
    .slice(0, limit);
  return { channel, serverNow: nowMs, programs };
}
