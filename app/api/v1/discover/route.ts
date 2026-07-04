import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getRequestUser } from "@/server/auth/auth-service";
import {
  getTrending,
  getPopularMovies,
  getPopularTv,
  getTrendingMovies,
  getTrendingTv,
  getTopRatedMovies,
  getTopRatedTv,
  discoverAnimeTv,
  discoverAnimeMovies,
  searchMovie,
  searchTv,
  posterUrl,
  backdropUrl,
  isAnimeMeta,
  type TmdbTrendingItem,
  type TmdbMovieSummary,
  type TmdbTvSummary,
} from "@/server/metadata/tmdb";
import {
  annotateAvailability,
  availabilityKey,
  type MediaKind,
  type AvailabilityStatus,
} from "@/server/metadata/availability";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface DiscoverItem {
  tmdbId: number;
  mediaType: MediaKind;
  title: string;
  year: number | null;
  /** Full poster URL for display. */
  poster: string | null;
  /** Raw TMDB poster path (e.g. "/abc.jpg") — stored when creating a request. */
  posterPath: string | null;
  /** Wide backdrop URL for hero billboards / landscape cards. */
  backdrop: string | null;
  /** Japanese-language Animation (genre 16) — used by the search type filter. */
  isAnime: boolean;
  overview: string;
  status: AvailabilityStatus;
  mediaId: number | null;
}

type BaseItem = Omit<DiscoverItem, "status" | "mediaId">;

function yearFrom(date?: string | null): number | null {
  return date ? Number(date.slice(0, 4)) || null : null;
}

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

function fromTrending(r: TmdbTrendingItem): BaseItem | null {
  if (r.media_type === "movie") {
    return {
      tmdbId: r.id,
      mediaType: "movie",
      title: r.title ?? "",
      year: yearFrom(r.release_date),
      poster: posterUrl(r.poster_path),
      posterPath: r.poster_path ?? null,
      backdrop: backdropUrl(r.backdrop_path),
      isAnime: isAnimeMeta(r.genre_ids, r.original_language),
      overview: r.overview ?? "",
    };
  }
  if (r.media_type === "tv") {
    return {
      tmdbId: r.id,
      mediaType: "series",
      title: r.name ?? "",
      year: yearFrom(r.first_air_date),
      poster: posterUrl(r.poster_path),
      posterPath: r.poster_path ?? null,
      backdrop: backdropUrl(r.backdrop_path),
      isAnime: isAnimeMeta(r.genre_ids, r.original_language),
      overview: r.overview ?? "",
    };
  }
  return null; // person results are ignored
}

/** Attach library availability to a set of TMDB titles. */
function annotate(base: BaseItem[]): DiscoverItem[] {
  const avail = annotateAvailability(base.map((b) => ({ tmdbId: b.tmdbId, mediaType: b.mediaType })));
  return base.map((b) => {
    const a = avail.get(availabilityKey(b.mediaType, b.tmdbId));
    // For a series already in the library, trust the library's isAnime flag over
    // the TMDB genre/language heuristic so it lands in the right category.
    const isAnime = a?.mediaId != null && b.mediaType === "series" ? a.isAnime : b.isAnime;
    return { ...b, isAnime, status: a?.status ?? "unavailable", mediaId: a?.mediaId ?? null };
  });
}

/** Recently-imported library titles (already available), newest file first. */
function recentlyAdded(): DiscoverItem[] {
  const db = getDb();

  const movieRows = db
    .select({
      id: schema.movies.id,
      tmdbId: schema.movies.tmdbId,
      title: schema.movies.title,
      year: schema.movies.year,
      posterPath: schema.movies.posterPath,
      backdropPath: schema.movies.backdropPath,
      overview: schema.movies.overview,
      dateAdded: schema.movieFiles.dateAdded,
    })
    .from(schema.movieFiles)
    .innerJoin(schema.movies, eq(schema.movies.id, schema.movieFiles.movieId))
    .orderBy(desc(schema.movieFiles.dateAdded))
    .limit(20)
    .all();

  const epRows = db
    .select({
      id: schema.series.id,
      tmdbId: schema.series.tmdbId,
      title: schema.series.title,
      year: schema.series.year,
      posterPath: schema.series.posterPath,
      backdropPath: schema.series.backdropPath,
      overview: schema.series.overview,
      isAnime: schema.series.isAnime,
      dateAdded: schema.episodeFiles.dateAdded,
    })
    .from(schema.episodeFiles)
    .innerJoin(schema.series, eq(schema.series.id, schema.episodeFiles.seriesId))
    .orderBy(desc(schema.episodeFiles.dateAdded))
    .limit(60)
    .all();

  const seenSeries = new Set<number>();
  const seriesRows = epRows.filter((r) => (seenSeries.has(r.id) ? false : seenSeries.add(r.id)));

  const ts = (d: Date | null) => (d ? d.getTime() : 0);
  const merged = [
    ...movieRows.map((r) => ({ kind: "movie" as const, ...r })),
    ...seriesRows.map((r) => ({ kind: "series" as const, ...r })),
  ]
    .sort((a, b) => ts(b.dateAdded) - ts(a.dateAdded))
    .slice(0, 20);

  return merged.map((r) => ({
    tmdbId: r.tmdbId,
    mediaType: r.kind === "movie" ? "movie" : "series",
    title: r.title,
    year: r.year,
    poster: posterUrl(r.posterPath),
    posterPath: r.posterPath,
    backdrop: backdropUrl(r.backdropPath),
    isAnime: r.kind === "series" ? r.isAnime : false,
    overview: r.overview ?? "",
    status: "available" as const,
    mediaId: r.id,
  }));
}

export async function GET(request: NextRequest) {
  if (!getRequestUser(request)) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const category = request.nextUrl.searchParams.get("category") ?? "trending";

  try {
    if (category === "recently-added") {
      return ok(recentlyAdded());
    }

    if (category === "search") {
      const q = request.nextUrl.searchParams.get("q")?.trim();
      if (!q) return badRequest("Missing ?q=");
      const [movies, tv] = await Promise.all([searchMovie(q), searchTv(q)]);
      const base = [
        ...movies.results.slice(0, 20).map(fromMovie),
        ...tv.results.slice(0, 20).map(fromTv),
      ].filter((b) => b.title);
      return ok(annotate(base));
    }

    // TMDB list feeds -> BaseItem[]. Movies / Series / Anime categories.
    const feeds: Record<string, () => Promise<BaseItem[]>> = {
      "popular-movies": async () => (await getPopularMovies()).results.map(fromMovie),
      "movies-popular": async () => (await getPopularMovies()).results.map(fromMovie),
      "movies-trending": async () => (await getTrendingMovies()).results.map(fromMovie),
      "movies-top": async () => (await getTopRatedMovies()).results.map(fromMovie),
      "popular-series": async () => (await getPopularTv()).results.map(fromTv),
      "series-popular": async () => (await getPopularTv()).results.map(fromTv),
      "series-trending": async () => (await getTrendingTv()).results.map(fromTv),
      "series-top": async () => (await getTopRatedTv()).results.map(fromTv),
      "anime-popular": async () => (await discoverAnimeTv("popularity.desc")).results.map(fromTv),
      "anime-new": async () => (await discoverAnimeTv("first_air_date.desc")).results.map(fromTv),
      "anime-top": async () => (await discoverAnimeTv("vote_average.desc")).results.map(fromTv),
      "anime-movies": async () => (await discoverAnimeMovies("popularity.desc")).results.map(fromMovie),
    };

    if (feeds[category]) {
      const items = annotate(await feeds[category]());
      // Keep anime out of the Series category and non-anime out of the Anime
      // category (library titles use their real flag; TMDB browse the heuristic).
      const filtered = category.startsWith("series-")
        ? items.filter((i) => !i.isAnime)
        : category.startsWith("anime-")
          ? items.filter((i) => i.isAnime)
          : items;
      return ok(filtered);
    }

    // default: trending (mixed movies + TV)
    const res = await getTrending();
    const base = res.results.map(fromTrending).filter((x): x is BaseItem => x !== null);
    return ok(annotate(base));
  } catch (err) {
    return serverError(err);
  }
}
