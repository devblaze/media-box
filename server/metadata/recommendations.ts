import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import {
  getMovieRecommendations,
  getTvRecommendations,
  posterUrl,
  backdropUrl,
  isAnimeMeta,
  type TmdbMovieSummary,
  type TmdbTvSummary,
} from "@/server/metadata/tmdb";
import {
  annotateAvailability,
  availabilityKey,
  type MediaKind,
} from "@/server/metadata/availability";
import { recentlyWatched } from "@/server/playback/watch-progress-service";
import type { DiscoverItem } from "@/app/api/v1/discover/route";

/** A "Because you watched X" row: the source title + its TMDB recommendations. */
export interface RecommendationGroup {
  basedOn: { tmdbId: number; mediaType: MediaKind; title: string };
  items: DiscoverItem[];
}

type BaseItem = Omit<DiscoverItem, "status" | "mediaId">;

const yearFrom = (date?: string | null): number | null =>
  date ? Number(date.slice(0, 4)) || null : null;

function fromMovie(r: TmdbMovieSummary): BaseItem {
  return {
    tmdbId: r.id,
    mediaType: "movie",
    title: r.title,
    year: yearFrom(r.release_date),
    poster: posterUrl(r.poster_path),
    posterPath: r.poster_path ?? null,
    backdrop: backdropUrl(r.backdrop_path),
    isAnime: isAnimeMeta(r.genre_ids, r.original_language),
    overview: r.overview ?? "",
  };
}

function fromTv(r: TmdbTvSummary): BaseItem {
  return {
    tmdbId: r.id,
    mediaType: "series",
    title: r.name,
    year: yearFrom(r.first_air_date),
    poster: posterUrl(r.poster_path),
    posterPath: r.poster_path ?? null,
    backdrop: backdropUrl(r.backdrop_path),
    isAnime: isAnimeMeta(r.genre_ids, r.original_language),
    overview: r.overview ?? "",
  };
}

/** Attach library availability (mirrors the discover feed's annotate()). */
function annotate(base: BaseItem[]): DiscoverItem[] {
  const avail = annotateAvailability(base.map((b) => ({ tmdbId: b.tmdbId, mediaType: b.mediaType })));
  return base.map((b) => {
    const a = avail.get(availabilityKey(b.mediaType, b.tmdbId));
    const isAnime = a?.mediaId != null && b.mediaType === "series" ? a.isAnime : b.isAnime;
    return { ...b, isAnime, status: a?.status ?? "unavailable", mediaId: a?.mediaId ?? null };
  });
}

interface Source {
  tmdbId: number;
  mediaType: MediaKind;
  title: string;
}

/** Resolve the distinct recently-watched titles to their TMDB id + kind, newest first. */
function recentSources(userId: number, max: number): Source[] {
  const db = getDb();
  const sources: Source[] = [];
  const seen = new Set<string>();
  for (const it of recentlyWatched(userId, 20)) {
    let src: Source | null = null;
    if (it.movieId != null) {
      const m = db
        .select({ tmdbId: schema.movies.tmdbId, title: schema.movies.title })
        .from(schema.movies)
        .where(eq(schema.movies.id, it.movieId))
        .get();
      if (m) src = { tmdbId: m.tmdbId, mediaType: "movie", title: m.title };
    } else if (it.seriesId != null) {
      const s = db
        .select({ tmdbId: schema.series.tmdbId, title: schema.series.title })
        .from(schema.series)
        .where(eq(schema.series.id, it.seriesId))
        .get();
      if (s) src = { tmdbId: s.tmdbId, mediaType: "series", title: s.title };
    }
    if (!src) continue;
    const key = availabilityKey(src.mediaType, src.tmdbId);
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(src);
    if (sources.length >= max) break;
  }
  return sources;
}

/**
 * "Because you watched X" rows for the Discover page: one row per recent title,
 * populated with TMDB's recommendations for it. The source title changes as the
 * user watches more. A group is only returned when it has enough real cards.
 */
export async function becauseYouWatched(
  userId: number,
  maxGroups = 3
): Promise<RecommendationGroup[]> {
  const sources = recentSources(userId, maxGroups);
  const groups: RecommendationGroup[] = [];

  for (const src of sources) {
    let base: BaseItem[];
    try {
      base =
        src.mediaType === "movie"
          ? (await getMovieRecommendations(src.tmdbId)).results.map(fromMovie)
          : (await getTvRecommendations(src.tmdbId)).results.map(fromTv);
    } catch {
      continue; // TMDB hiccup for this title — just skip its row
    }
    // Drop the source itself and posterless entries, then annotate + cap.
    const items = annotate(base.filter((b) => b.tmdbId !== src.tmdbId && b.poster)).slice(0, 20);
    if (items.length >= 4) groups.push({ basedOn: src, items });
  }

  return groups;
}
