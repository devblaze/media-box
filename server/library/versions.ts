/**
 * Lists the on-disk files (quality versions) a movie/episode has, so the player
 * can offer a quality picker and show what's playing. A movie can hold several
 * `movie_files` rows (e.g. a 1080p and a 4K); the one referenced by
 * `movies.movieFileId` is the primary.
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import type { MediaInfo } from "./media-info";
import { getQuality, type QualityModel } from "@/server/parser/quality";

export interface MediaVersion {
  fileId: number;
  /** Short resolution tag: "4K" | "1080p" | "720p" | "480p" | "SD". */
  resolution: string;
  /** Fuller label, e.g. "4K · WEB-DL-2160p". */
  label: string;
  size: number;
  isPrimary: boolean;
  /** Probed total runtime (seconds), null if unknown. The player uses this as the
   *  authoritative duration, since a live transcode's `<video>.duration` only
   *  reflects what's been encoded so far. */
  durationSec: number | null;
}

function resTag(height: number | null | undefined, fallback: number): string {
  const h = height ?? fallback ?? 0;
  if (h >= 2160) return "4K";
  if (h >= 1080) return "1080p";
  if (h >= 720) return "720p";
  if (h >= 480) return "480p";
  return "SD";
}

function toVersion(
  f: { id: number; quality: unknown; mediaInfo: unknown; size: number },
  isPrimary: boolean
): MediaVersion & { rank: number } {
  const mi = f.mediaInfo as MediaInfo | null;
  const q = f.quality as QualityModel | null;
  const def = getQuality(q?.qualityId ?? 0);
  const tag = resTag(mi?.video?.height, def.resolution);
  return {
    fileId: f.id,
    resolution: tag,
    label: def.name && def.name !== "Unknown" ? `${tag} · ${def.name}` : tag,
    size: f.size,
    isPrimary,
    durationSec: mi?.durationSec ?? null,
    rank: mi?.video?.height ?? def.resolution ?? 0,
  };
}

export function listMovieVersions(movieId: number): MediaVersion[] {
  const db = getDb();
  const movie = db
    .select({ primary: schema.movies.movieFileId })
    .from(schema.movies)
    .where(eq(schema.movies.id, movieId))
    .get();
  const files = db
    .select({
      id: schema.movieFiles.id,
      quality: schema.movieFiles.quality,
      mediaInfo: schema.movieFiles.mediaInfo,
      size: schema.movieFiles.size,
    })
    .from(schema.movieFiles)
    .where(eq(schema.movieFiles.movieId, movieId))
    .all();

  return files
    .map((f) => toVersion(f, f.id === movie?.primary))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || b.rank - a.rank)
    .map(({ rank: _rank, ...v }) => v);
}

export function listEpisodeVersions(episodeId: number): MediaVersion[] {
  const db = getDb();
  const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get();
  if (!ep?.episodeFileId) return [];
  const f = db
    .select({
      id: schema.episodeFiles.id,
      quality: schema.episodeFiles.quality,
      mediaInfo: schema.episodeFiles.mediaInfo,
      size: schema.episodeFiles.size,
    })
    .from(schema.episodeFiles)
    .where(eq(schema.episodeFiles.id, ep.episodeFileId))
    .get();
  if (!f) return [];
  const { rank: _rank, ...v } = toVersion(f, true);
  return [v];
}
