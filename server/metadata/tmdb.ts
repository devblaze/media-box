import { getSettings } from "@/server/settings/settings-service";

const BASE = "https://api.themoviedb.org/3";
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

// Token bucket: TMDB allows ~40 requests per 10 seconds; stay under it.
const BUCKET_SIZE = 35;
const REFILL_MS = 10_000;

const LIMITER_KEY = Symbol.for("mediabox.tmdbLimiter");
type Limiter = { tokens: number; lastRefill: number; waiters: (() => void)[] };
type GlobalWithLimiter = typeof globalThis & { [LIMITER_KEY]?: Limiter };

function getLimiter(): Limiter {
  const g = globalThis as GlobalWithLimiter;
  if (!g[LIMITER_KEY]) g[LIMITER_KEY] = { tokens: BUCKET_SIZE, lastRefill: Date.now(), waiters: [] };
  return g[LIMITER_KEY];
}

async function takeToken(): Promise<void> {
  const limiter = getLimiter();
  for (;;) {
    const now = Date.now();
    if (now - limiter.lastRefill >= REFILL_MS) {
      limiter.tokens = BUCKET_SIZE;
      limiter.lastRefill = now;
    }
    if (limiter.tokens > 0) {
      limiter.tokens--;
      return;
    }
    await new Promise((r) => setTimeout(r, limiter.lastRefill + REFILL_MS - now + 50));
  }
}

export class TmdbError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message);
  }
}

export async function tmdb<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const { tmdbApiKey } = getSettings();
  if (!tmdbApiKey) throw new TmdbError("TMDB API key is not configured (Settings → General)");
  await takeToken();
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api_key", tmdbApiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new TmdbError(`TMDB ${path} responded ${res.status}`, res.status);
  return res.json() as Promise<T>;
}

// ---------- typed endpoints ----------

export interface TmdbSearchResult<T> {
  page: number;
  total_pages: number;
  total_results: number;
  results: T[];
}

export interface TmdbTvSummary {
  id: number;
  name: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
}

export interface TmdbMovieSummary {
  id: number;
  title: string;
  release_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
}

export interface TmdbTvDetails extends TmdbTvSummary {
  status: string;
  networks: { name: string }[];
  episode_run_time: number[];
  number_of_seasons: number;
  seasons: { season_number: number; episode_count: number }[];
  external_ids?: { imdb_id?: string | null; tvdb_id?: number | null };
}

export interface TmdbSeasonDetails {
  season_number: number;
  episodes: {
    id: number;
    season_number: number;
    episode_number: number;
    name?: string;
    overview?: string;
    air_date?: string | null;
    runtime?: number | null;
  }[];
}

export interface TmdbMovieDetails extends TmdbMovieSummary {
  status: string;
  runtime?: number | null;
  imdb_id?: string | null;
  external_ids?: { imdb_id?: string | null };
}

export const searchTv = (query: string) =>
  tmdb<TmdbSearchResult<TmdbTvSummary>>("/search/tv", { query });

export const searchMovie = (query: string) =>
  tmdb<TmdbSearchResult<TmdbMovieSummary>>("/search/movie", { query });

export const getTv = (tmdbId: number) =>
  tmdb<TmdbTvDetails>(`/tv/${tmdbId}`, { append_to_response: "external_ids" });

export const getTvSeason = (tmdbId: number, seasonNumber: number) =>
  tmdb<TmdbSeasonDetails>(`/tv/${tmdbId}/season/${seasonNumber}`);

export const getMovie = (tmdbId: number) =>
  tmdb<TmdbMovieDetails>(`/movie/${tmdbId}`, { append_to_response: "external_ids" });

export const findByTvdbId = (tvdbId: number) =>
  tmdb<{ tv_results: TmdbTvSummary[] }>(`/find/${tvdbId}`, { external_source: "tvdb_id" });

export function posterUrl(path: string | null | undefined, size = "w342"): string | null {
  return path ? `${TMDB_IMAGE_BASE}/${size}${path}` : null;
}

// ---------- discover / trending ----------

export interface TmdbTrendingItem {
  id: number;
  media_type: "movie" | "tv" | "person";
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
}

/** Trending movies + TV for the week (mixed; `person` results are filtered by callers). */
export const getTrending = () =>
  tmdb<TmdbSearchResult<TmdbTrendingItem>>("/trending/all/week");

export const getPopularMovies = () =>
  tmdb<TmdbSearchResult<TmdbMovieSummary>>("/movie/popular");

export const getPopularTv = () => tmdb<TmdbSearchResult<TmdbTvSummary>>("/tv/popular");
