import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getRequestUser } from "@/server/auth/auth-service";
import {
  getTrending,
  getPopularMovies,
  getPopularTv,
  searchMovie,
  searchTv,
  posterUrl,
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
    return { ...b, status: a?.status ?? "unavailable", mediaId: a?.mediaId ?? null };
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
      overview: schema.series.overview,
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

    if (category === "popular-movies") {
      const res = await getPopularMovies();
      return ok(annotate(res.results.map(fromMovie)));
    }

    if (category === "popular-series") {
      const res = await getPopularTv();
      return ok(annotate(res.results.map(fromTv)));
    }

    // default: trending (mixed movies + TV)
    const res = await getTrending();
    const base = res.results.map(fromTrending).filter((x): x is BaseItem => x !== null);
    return ok(annotate(base));
  } catch (err) {
    return serverError(err);
  }
}
