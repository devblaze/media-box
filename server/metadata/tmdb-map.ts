import type { TmdbMovieDetails, TmdbTvDetails } from "./tmdb";
import { sortTitle } from "@/server/library/naming-utils";

export function mapSeriesStatus(tmdbStatus: string): "continuing" | "ended" | "upcoming" {
  switch (tmdbStatus) {
    case "Ended":
    case "Canceled":
      return "ended";
    case "In Production":
    case "Planned":
      return "upcoming";
    default:
      return "continuing";
  }
}

export function mapMovieStatus(tmdbStatus: string): "announced" | "inCinemas" | "released" {
  switch (tmdbStatus) {
    case "Released":
      return "released";
    case "In Production":
    case "Post Production":
      return "inCinemas";
    default:
      return "announced";
  }
}

export function mapSeries(details: TmdbTvDetails) {
  const year = details.first_air_date ? Number(details.first_air_date.slice(0, 4)) : null;
  return {
    tmdbId: details.id,
    tvdbId: details.external_ids?.tvdb_id ?? null,
    imdbId: details.external_ids?.imdb_id ?? null,
    title: details.name,
    sortTitle: sortTitle(details.name),
    year,
    overview: details.overview ?? null,
    status: mapSeriesStatus(details.status),
    network: details.networks[0]?.name ?? null,
    runtime: details.episode_run_time[0] ?? null,
    posterPath: details.poster_path ?? null,
    backdropPath: details.backdrop_path ?? null,
  };
}

export function mapMovie(details: TmdbMovieDetails) {
  const year = details.release_date ? Number(details.release_date.slice(0, 4)) : null;
  return {
    tmdbId: details.id,
    imdbId: details.external_ids?.imdb_id ?? details.imdb_id ?? null,
    title: details.title,
    sortTitle: sortTitle(details.title),
    year,
    overview: details.overview ?? null,
    status: mapMovieStatus(details.status),
    runtime: details.runtime ?? null,
    posterPath: details.poster_path ?? null,
    backdropPath: details.backdrop_path ?? null,
    digitalRelease: null as Date | null,
    physicalRelease: null as Date | null,
  };
}
