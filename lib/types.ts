export interface LookupResult {
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string;
  poster: string | null;
}

export interface RootFolder {
  id: number;
  path: string;
  mediaType: "series" | "movies" | "anime";
  accessible?: boolean;
  freeSpace?: number | null;
}

export interface QualityProfile {
  id: number;
  name: string;
  upgradeAllowed: boolean;
  cutoffQualityId: number;
  items: { qualityId: number; allowed: boolean }[];
  /** Matched terms add their score (negative to avoid). Highest total wins. */
  preferredTerms: { term: string; score: number }[];
  /** If any set, a release must contain at least one to be eligible. */
  requiredTerms: string[];
  /** A release is rejected if it contains any of these. */
  ignoredTerms: string[];
}

export interface SeriesSummary {
  id: number;
  tmdbId: number;
  title: string;
  sortTitle: string;
  year: number | null;
  status: string;
  network: string | null;
  posterPath: string | null;
  path: string;
  monitored: boolean;
  monitorMode: "all" | "future" | "none";
  isAnime: boolean;
  qualityProfileId: number;
  episodeCount: number;
  episodeFileCount: number;
}

export interface MovieSummary {
  id: number;
  tmdbId: number;
  title: string;
  sortTitle: string;
  year: number | null;
  status: string;
  posterPath: string | null;
  path: string;
  monitored: boolean;
  qualityProfileId: number;
  movieFileId: number | null;
}

export interface Episode {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  airDateUtc: number | string | null;
  monitored: boolean;
  episodeFileId: number | null;
}

export interface Season {
  id: number;
  seriesId: number;
  seasonNumber: number;
  monitored: boolean;
}

export interface ScheduledTask {
  id: number;
  name: string;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: number | string | null;
  lastDurationMs: number | null;
  lastResult: string | null;
  nextRunAt: number | string | null;
}

export interface CommandRow {
  id: number;
  name: string;
  status: "queued" | "started" | "completed" | "failed";
  trigger: string;
  queuedAt: number | string;
  endedAt: number | string | null;
  error: string | null;
}

export function tmdbPoster(posterPath: string | null, size = "w342"): string | null {
  return posterPath ? `https://image.tmdb.org/t/p/${size}${posterPath}` : null;
}

/** Compact "just now / 5m ago / 3h ago / 2d ago" for an epoch-ms timestamp. */
export function timeAgo(ms: number | null | undefined): string {
  if (ms == null) return "never";
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
