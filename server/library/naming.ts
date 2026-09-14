import {
  qualityName,
  sonarrQualityFull,
  sonarrQualityTitle,
  type QualityModel,
} from "@/server/parser/quality";
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

// ---------- multi-episode styles ----------

/**
 * How a file covering several episodes renders its episode numbers. Names and
 * output match Sonarr's "Multi Episode Style" setting so a file written here is
 * re-parseable by Sonarr and vice versa.
 *
 *   extend         E01-02-03   (Sonarr's default)
 *   scene          E01-E02-E03
 *   repeat         E01E02E03
 *   range          E01-03      (first and last only)
 *   prefixedRange  E01-E03     (first and last only)
 *
 * Sonarr's "duplicate" style (`S01E01.S01E02`) is deliberately not offered: it
 * repeats the whole season+episode prefix, which does not fit a token that only
 * knows the episode numbers.
 */
export const MULTI_EPISODE_STYLES = ["extend", "scene", "repeat", "range", "prefixedRange"] as const;
export type MultiEpisodeStyle = (typeof MULTI_EPISODE_STYLES)[number];

/**
 * Sonarr's default, and the `naming_config.multi_episode_style` default a NEW
 * install is created with.
 */
export const DEFAULT_MULTI_EPISODE_STYLE: MultiEpisodeStyle = "extend";

/**
 * What media-box rendered before the style was configurable, and what an
 * existing install is migrated onto so its library keeps the names it has.
 *
 * It is also the fallback `renderEpisodeFilename` uses when the caller passes
 * no style at all — a caller that has not been wired to `naming_config` yet
 * must keep producing byte-identical names, never quietly switch a library to a
 * second scheme. The real default lives in the database, not here.
 */
export const LEGACY_MULTI_EPISODE_STYLE: MultiEpisodeStyle = "scene";

export function isMultiEpisodeStyle(value: unknown): value is MultiEpisodeStyle {
  return (MULTI_EPISODE_STYLES as readonly string[]).includes(value as string);
}

// ---------- stock formats ----------

/**
 * The formats Sonarr and Radarr ship with, so a library written by media-box is
 * recognisable to them (and vice versa).
 *
 * These are ALSO the drizzle column defaults in `server/db/schema.ts`, which is
 * the only place a *new* install picks them up — an existing `naming_config`
 * row is never rewritten from here. `naming.test.ts` asserts the two stay in
 * step.
 */
export const SONARR_DEFAULTS = {
  standardEpisodeFormat:
    "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}",
  animeEpisodeFormat:
    "{Series Title} - S{season:00}E{episode:00} - {absolute:000} - {Episode Title} {Quality Full}",
  seriesFolderFormat: "{Series Title} ({Year})",
  seasonFolderFormat: "Season {season:00}",
  specialsFolderFormat: "Specials",
  movieFormat: "{Movie Title} ({Year}) {Quality Full}",
  movieFolderFormat: "{Movie Title} ({Year})",
  multiEpisodeStyle: DEFAULT_MULTI_EPISODE_STYLE,
} as const;

// ---------- contexts ----------

export interface EpisodeNamingContext {
  seriesTitle: string;
  seriesYear?: number | null;
  seasonNumber: number;
  /** sorted episode numbers covered by the file */
  episodeNumbers: number[];
  /**
   * Absolute episode numbers for the same episodes, in the same order as
   * `episodeNumbers`. `episodes.absolute_number` is nullable, so entries may be
   * null/undefined and the array may be omitted entirely — the `{absolute}`
   * tokens then render empty and the renderer collapses the separator left
   * behind.
   */
  absoluteNumbers?: (number | null | undefined)[] | null;
  episodeTitle?: string | null;
  quality: QualityModel;
  releaseGroup?: string | null;
  /**
   * From `naming_config.multiEpisodeStyle`. Omitting it falls back to
   * LEGACY_MULTI_EPISODE_STYLE ("scene"), i.e. exactly what media-box rendered
   * before the setting existed — pass the configured value to honour it.
   */
  multiEpisodeStyle?: MultiEpisodeStyle | null;
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

/**
 * Render a run of numbers in the given multi-episode style. `prefix` is "E" for
 * episode numbers and "" for absolute numbers (Sonarr writes `001-002`, not
 * `E001-E002`).
 */
function numberRun(
  numbers: number[],
  width: number,
  style: MultiEpisodeStyle,
  prefix: string
): string {
  if (numbers.length === 0) return "";
  const p = (n: number) => `${prefix}${pad(n, width)}`;
  const bare = (n: number) => pad(n, width);
  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  if (numbers.length === 1) return p(first);
  switch (style) {
    case "scene":
      return numbers.map(p).join("-");
    case "repeat":
      return numbers.map(p).join("");
    case "range":
      return `${p(first)}-${bare(last)}`;
    case "prefixedRange":
      return `${p(first)}-${p(last)}`;
    case "extend":
    default:
      return [p(first), ...numbers.slice(1).map(bare)].join("-");
  }
}

/**
 * Substitute tokens. Unknown tokens are left verbatim on purpose: a typo in a
 * user's format shows up in the filename instead of silently vanishing, which
 * is also how Sonarr behaves for tokens it does not know.
 */
function render(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [token, value] of Object.entries(values)) {
    out = out.replaceAll(token, value);
  }
  // drop empty bracket groups like " []" left by missing values
  out = out.replace(/\s*\[\s*\]/g, "").replace(/\s*\(\s*\)/g, "");
  out = out.replace(/\s+/g, " ").trim();
  // A token that rendered empty (a missing absolute number, a missing episode
  // title) leaves a run of " - " separators behind; collapse the run back to a
  // single separator and drop one left dangling at either end.
  out = out.replace(/ - (?:- )+/g, " - ");
  out = out.replace(/^-\s+/, "").replace(/\s+-$/, "");
  return out.trim();
}

export function renderEpisodeFilename(
  template: string,
  ctx: EpisodeNamingContext,
  opts?: RenderOptions
): string {
  const style = isMultiEpisodeStyle(ctx.multiEpisodeStyle)
    ? ctx.multiEpisodeStyle
    : LEGACY_MULTI_EPISODE_STYLE;
  const episodes = ctx.episodeNumbers.length > 0 ? ctx.episodeNumbers : [1];
  const absolutes = (ctx.absoluteNumbers ?? []).filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n)
  );
  const values: Record<string, string> = {
    "{Series Title}": ctx.seriesTitle,
    "{Year}": ctx.seriesYear ? String(ctx.seriesYear) : "",
    // composite first: it contains {season:00} and {episode:00} as substrings
    "S{season:00}E{episode:00}": `S${pad(ctx.seasonNumber, 2)}${numberRun(episodes, 2, style, "E")}`,
    "{season:00}": pad(ctx.seasonNumber, 2),
    "{season}": String(ctx.seasonNumber),
    "{episode:00}": numberRun(episodes, 2, style, ""),
    "{episode}": numberRun(episodes, 0, style, ""),
    "{absolute:000}": numberRun(absolutes, 3, style, ""),
    "{absolute:00}": numberRun(absolutes, 2, style, ""),
    "{absolute}": numberRun(absolutes, 0, style, ""),
    "{Episode Title}": ctx.episodeTitle ?? "",
    "{Quality Full}": sonarrQualityFull(ctx.quality),
    "{Quality Title}": sonarrQualityTitle(ctx.quality),
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

export interface SeasonFolderOptions {
  /**
   * Format for season 0. Sonarr keeps this separate from the season folder
   * format and defaults it to `Specials`. Omit it (or pass empty) to keep the
   * old behaviour of rendering season 0 through `template` as `Season 00`.
   */
  specialsFormat?: string | null;
}

export function renderSeasonFolder(
  template: string,
  seasonNumber: number,
  opts?: SeasonFolderOptions
): string {
  const specials = opts?.specialsFormat?.trim();
  const tpl = seasonNumber === 0 && specials ? specials : template;
  return sanitizePathComponent(
    render(tpl, {
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
      "{Quality Full}": sonarrQualityFull(ctx.quality),
      "{Quality Title}": sonarrQualityTitle(ctx.quality),
      "{Quality}": qualityName(ctx.quality),
      "{Release Group}": ctx.releaseGroup ?? "",
    }),
    opts
  );
}
