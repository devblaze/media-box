import { qualityName, type QualityModel } from "@/server/parser/quality";
import { sanitizePathComponent, stripPathSeparators } from "./naming-utils";

export interface RenderOptions {
  /**
   * Mirrors namingConfig.replaceIllegalCharacters. When false, keep characters
   * like ':' '?' '*' and only strip path separators / control chars.
   */
  replaceIllegal?: boolean;
}

function sanitize(name: string, opts?: RenderOptions): string {
  return opts?.replaceIllegal === false ? stripPathSeparators(name) : sanitizePathComponent(name);
}

export interface EpisodeNamingContext {
  seriesTitle: string;
  seriesYear?: number | null;
  seasonNumber: number;
  /** sorted episode numbers covered by the file */
  episodeNumbers: number[];
  episodeTitle?: string | null;
  quality: QualityModel;
  releaseGroup?: string | null;
}

export interface MovieNamingContext {
  movieTitle: string;
  movieYear?: number | null;
  quality: QualityModel;
  releaseGroup?: string | null;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

// Supported tokens: {Series Title} {Movie Title} {Episode Title} {Year}
// {season:00} {season} {episode:00} {episode} {Quality} {Release Group}
function render(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [token, value] of Object.entries(values)) {
    out = out.replaceAll(token, value);
  }
  // drop empty bracket groups like " []" left by missing values
  out = out.replace(/\s*\[\s*\]/g, "").replace(/\s*\(\s*\)/g, "");
  return out.replace(/\s+/g, " ").trim();
}

function episodeToken(numbers: number[], seasonNumber: number): string {
  if (numbers.length <= 1) return `E${pad(numbers[0] ?? 1, 2)}`;
  return `E${pad(numbers[0], 2)}-E${pad(numbers[numbers.length - 1], 2)}`;
}

export function renderEpisodeFilename(
  template: string,
  ctx: EpisodeNamingContext,
  opts?: RenderOptions
): string {
  const epPart = episodeToken(ctx.episodeNumbers, ctx.seasonNumber);
  const values: Record<string, string> = {
    "{Series Title}": ctx.seriesTitle,
    "{Year}": ctx.seriesYear ? String(ctx.seriesYear) : "",
    "S{season:00}E{episode:00}": `S${pad(ctx.seasonNumber, 2)}${epPart}`,
    "{season:00}": pad(ctx.seasonNumber, 2),
    "{season}": String(ctx.seasonNumber),
    "{episode:00}": pad(ctx.episodeNumbers[0] ?? 1, 2),
    "{episode}": String(ctx.episodeNumbers[0] ?? 1),
    "{Episode Title}": ctx.episodeTitle ?? "",
    "{Quality}": qualityName(ctx.quality),
    "{Release Group}": ctx.releaseGroup ?? "",
  };
  return sanitize(render(template, values), opts);
}

export function renderSeriesFolder(template: string, ctx: { title: string; year?: number | null }): string {
  return sanitizePathComponent(
    render(template, {
      "{Series Title}": ctx.title,
      "{Year}": ctx.year ? String(ctx.year) : "",
    })
  );
}

export function renderMovieFolder(template: string, ctx: { title: string; year?: number | null }): string {
  return sanitizePathComponent(
    render(template, {
      "{Movie Title}": ctx.title,
      "{Year}": ctx.year ? String(ctx.year) : "",
    })
  );
}

export function renderSeasonFolder(template: string, seasonNumber: number): string {
  return sanitizePathComponent(
    render(template, {
      "{season:00}": pad(seasonNumber, 2),
      "{season}": String(seasonNumber),
    })
  );
}

export function renderMovieFilename(
  template: string,
  ctx: MovieNamingContext,
  opts?: RenderOptions
): string {
  return sanitize(
    render(template, {
      "{Movie Title}": ctx.movieTitle,
      "{Year}": ctx.movieYear ? String(ctx.movieYear) : "",
      "{Quality}": qualityName(ctx.quality),
      "{Release Group}": ctx.releaseGroup ?? "",
    }),
    opts
  );
}
