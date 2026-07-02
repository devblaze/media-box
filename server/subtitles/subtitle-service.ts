/**
 * Subtitle service: finds video files missing subtitles in the configured
 * languages, downloads them from the active provider, and writes them as
 * sidecar files next to the video (e.g. `Movie (2020).en.srt`) — the Bazarr/
 * Jellyfin/Plex convention.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getSettings } from "@/server/settings/settings-service";
import { searchSubtitles, downloadSubtitle, type SearchQuery } from "./opensubtitles";
import { emitEvent } from "@/server/events/bus";

export type SubtitleTarget =
  | { kind: "movie"; id: number }
  | { kind: "episode"; id: number };

/** A search scope: a single movie/episode, or a whole series (all its episodes). */
export type SubtitleScope = SubtitleTarget | { kind: "series"; id: number };

export interface WantedSubtitle {
  target: SubtitleTarget;
  language: string;
}

/** Configured wanted languages (ISO 639-1), empty when subtitles are off. */
export function wantedLanguages(): string[] {
  const s = getSettings();
  if (s.subtitleProvider === "none") return [];
  return s.subtitleLanguages
    .split(",")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
}

interface VideoRef {
  /** Absolute path of the video file. */
  absVideo: string;
  /** Library root the sidecar path is stored relative to (movie.path / series.path). */
  root: string;
  query: Omit<SearchQuery, "language">;
}

function movieVideo(movieId: number): VideoRef | null {
  const db = getDb();
  const row = db
    .select({
      moviePath: schema.movies.path,
      imdbId: schema.movies.imdbId,
      tmdbId: schema.movies.tmdbId,
      relativePath: schema.movieFiles.relativePath,
    })
    .from(schema.movies)
    .innerJoin(schema.movieFiles, eq(schema.movieFiles.id, schema.movies.movieFileId))
    .where(eq(schema.movies.id, movieId))
    .get();
  if (!row) return null;
  return {
    absVideo: path.join(row.moviePath, row.relativePath),
    root: row.moviePath,
    query: { imdbId: row.imdbId, tmdbId: row.tmdbId },
  };
}

function episodeVideo(episodeId: number): VideoRef | null {
  const db = getDb();
  const row = db
    .select({
      seriesPath: schema.series.path,
      parentImdbId: schema.series.imdbId,
      parentTmdbId: schema.series.tmdbId,
      seasonNumber: schema.episodes.seasonNumber,
      episodeNumber: schema.episodes.episodeNumber,
      relativePath: schema.episodeFiles.relativePath,
    })
    .from(schema.episodes)
    .innerJoin(schema.episodeFiles, eq(schema.episodeFiles.id, schema.episodes.episodeFileId))
    .innerJoin(schema.series, eq(schema.series.id, schema.episodes.seriesId))
    .where(eq(schema.episodes.id, episodeId))
    .get();
  if (!row) return null;
  return {
    absVideo: path.join(row.seriesPath, row.relativePath),
    root: row.seriesPath,
    query: {
      parentImdbId: row.parentImdbId,
      parentTmdbId: row.parentTmdbId,
      season: row.seasonNumber,
      episode: row.episodeNumber,
    },
  };
}

/** Sidecar path (e.g. "…/Movie (2020).en.srt") for a video + language. */
function sidecarPath(absVideo: string, language: string): string {
  const dir = path.dirname(absVideo);
  const base = path.basename(absVideo, path.extname(absVideo));
  return path.join(dir, `${base}.${language}.srt`);
}

function hasSubtitle(target: SubtitleTarget, language: string): boolean {
  const db = getDb();
  const where =
    target.kind === "movie"
      ? and(eq(schema.subtitleFiles.movieId, target.id), eq(schema.subtitleFiles.language, language))
      : and(
          eq(schema.subtitleFiles.episodeId, target.id),
          eq(schema.subtitleFiles.language, language)
        );
  return !!db.select({ id: schema.subtitleFiles.id }).from(schema.subtitleFiles).where(where).get();
}

/**
 * All (target, language) pairs that have a video file on disk but no subtitle
 * recorded in one of the wanted languages. Optionally scoped to one title.
 */
export function wantedSubtitles(scope?: SubtitleScope): WantedSubtitle[] {
  const langs = wantedLanguages();
  if (langs.length === 0) return [];
  const db = getDb();
  const wanted: WantedSubtitle[] = [];

  const movieIds =
    scope?.kind === "movie"
      ? [scope.id]
      : scope
        ? []
        : db
            .select({ id: schema.movies.id })
            .from(schema.movies)
            .where(isNotNull(schema.movies.movieFileId))
            .all()
            .map((r) => r.id);
  for (const id of movieIds) {
    for (const language of langs) {
      if (!hasSubtitle({ kind: "movie", id }, language)) {
        wanted.push({ target: { kind: "movie", id }, language });
      }
    }
  }

  const episodeIds =
    scope?.kind === "episode"
      ? [scope.id]
      : scope?.kind === "series"
        ? db
            .select({ id: schema.episodes.id })
            .from(schema.episodes)
            .where(
              and(
                eq(schema.episodes.seriesId, scope.id),
                isNotNull(schema.episodes.episodeFileId)
              )
            )
            .all()
            .map((r) => r.id)
        : scope
          ? []
          : db
              .select({ id: schema.episodes.id })
              .from(schema.episodes)
              .where(isNotNull(schema.episodes.episodeFileId))
              .all()
              .map((r) => r.id);
  for (const id of episodeIds) {
    for (const language of langs) {
      if (!hasSubtitle({ kind: "episode", id }, language)) {
        wanted.push({ target: { kind: "episode", id }, language });
      }
    }
  }

  return wanted;
}

/**
 * Search + download one subtitle for a target/language, writing the sidecar and
 * recording it. Returns true if a subtitle was downloaded.
 */
export async function downloadSubtitleFor(
  target: SubtitleTarget,
  language: string
): Promise<boolean> {
  if (hasSubtitle(target, language)) return false;
  const ref = target.kind === "movie" ? movieVideo(target.id) : episodeVideo(target.id);
  if (!ref) return false;

  const hi = getSettings().subtitleHearingImpaired;
  const candidates = await searchSubtitles({ ...ref.query, language, hearingImpaired: hi });
  const best = candidates[0];
  if (!best) return false;

  const content = await downloadSubtitle(best.fileId);
  const abs = sidecarPath(ref.absVideo, language);
  await fs.writeFile(abs, content, "utf8");

  const db = getDb();
  db.insert(schema.subtitleFiles)
    .values({
      movieId: target.kind === "movie" ? target.id : null,
      episodeId: target.kind === "episode" ? target.id : null,
      language,
      relativePath: path.relative(ref.root, abs),
      provider: "opensubtitles",
      hearingImpaired: best.hearingImpaired,
      addedAt: new Date(),
    })
    .run();

  if (target.kind === "movie") emitEvent({ type: "movie.updated", movieId: target.id });
  else {
    const seriesId = db
      .select({ seriesId: schema.episodes.seriesId })
      .from(schema.episodes)
      .where(eq(schema.episodes.id, target.id))
      .get()?.seriesId;
    if (seriesId) emitEvent({ type: "series.updated", seriesId });
  }
  return true;
}

// ---------- Track listing + resolution (for the in-app player) ----------

export interface SubtitleTrackInfo {
  id: number;
  language: string;
  hearingImpaired: boolean;
}

export function listSubtitleTracks(target: { movieId?: number; episodeId?: number }): SubtitleTrackInfo[] {
  const db = getDb();
  const rows = target.movieId
    ? db.select().from(schema.subtitleFiles).where(eq(schema.subtitleFiles.movieId, target.movieId)).all()
    : target.episodeId
      ? db.select().from(schema.subtitleFiles).where(eq(schema.subtitleFiles.episodeId, target.episodeId)).all()
      : [];
  return rows.map((r) => ({ id: r.id, language: r.language, hearingImpaired: r.hearingImpaired }));
}

/** Absolute on-disk path of a subtitle sidecar file, or null if unknown. */
export function subtitleAbsPath(id: number): string | null {
  const db = getDb();
  const row = db.select().from(schema.subtitleFiles).where(eq(schema.subtitleFiles.id, id)).get();
  if (!row) return null;
  if (row.movieId != null) {
    const m = db
      .select({ path: schema.movies.path })
      .from(schema.movies)
      .where(eq(schema.movies.id, row.movieId))
      .get();
    return m ? path.join(m.path, row.relativePath) : null;
  }
  if (row.episodeId != null) {
    const s = db
      .select({ path: schema.series.path })
      .from(schema.series)
      .innerJoin(schema.episodes, eq(schema.episodes.seriesId, schema.series.id))
      .where(eq(schema.episodes.id, row.episodeId))
      .get();
    return s ? path.join(s.path, row.relativePath) : null;
  }
  return null;
}
