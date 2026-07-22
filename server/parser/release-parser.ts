import { QUALITIES, type QualityModel, type QualitySource, type Resolution } from "./quality";
import { normalizeTitle } from "@/server/library/naming-utils";

export interface ParsedRelease {
  originalTitle: string;
  /** cleaned title portion before the season/episode or year marker */
  title: string;
  normalizedTitle: string;
  year?: number;
  seasons: number[];
  /** empty with seasons present => full-season pack */
  episodes: number[];
  isFullSeason: boolean;
  isMultiSeason: boolean;
  quality: QualityModel;
  releaseGroup?: string;
  /** true when the name looks like a TV release (has S/E markers) */
  isTv: boolean;
}

// ---------- quality ----------

interface QualityClue {
  source?: QualitySource;
  resolution?: Resolution;
}

const SOURCE_PATTERNS: [RegExp, QualitySource][] = [
  [/\b(blu-?ray|bd(rip|remux)?|bdmv|brrip)\b/i, "bluray"],
  [/\bremux\b/i, "bluray"],
  [/\bweb[-. ]?dl\b/i, "webdl"],
  [/\b(webrip|web[-. ]?rip)\b/i, "webrip"],
  // bare WEB counts as WEB-DL (scene convention since ~2017)
  [/\bweb\b/i, "webdl"],
  [/\b(hdtv|pdtv|dsr|tvrip)\b/i, "hdtv"],
  [/\b(dvd(rip)?|ntsc|pal|xvid)\b/i, "dvd"],
  [/\bsdtv\b/i, "sdtv"],
];

const RESOLUTION_PATTERNS: [RegExp, Resolution][] = [
  [/\b(2160p|4k|uhd)\b/i, 2160],
  [/\b1080[pi]\b/i, 1080],
  [/\b720p\b/i, 720],
  [/\b(480[pi]|576[pi])\b/i, 480],
];

function parseQualityClues(name: string): QualityClue {
  const clue: QualityClue = {};
  for (const [re, source] of SOURCE_PATTERNS) {
    if (re.test(name)) {
      clue.source = source;
      break;
    }
  }
  for (const [re, resolution] of RESOLUTION_PATTERNS) {
    if (re.test(name)) {
      clue.resolution = resolution;
      break;
    }
  }
  return clue;
}

export function parseQuality(name: string): QualityModel {
  const clue = parseQualityClues(name);
  const version = /\b(proper|repack|rerip)\b/i.test(name) ? 2 : 1;
  const real = /\breal\b/.test(name) ? 1 : 0; // REAL is case-sensitive by scene convention

  let source = clue.source;
  let resolution = clue.resolution;

  // sensible defaults mirroring Sonarr: source without resolution and vice versa
  if (source && !resolution) {
    resolution = source === "dvd" || source === "sdtv" ? 480 : 720;
  }
  if (!source && resolution) {
    source = resolution >= 720 ? "webdl" : "sdtv";
  }
  if (!source || !resolution) {
    return { qualityId: 0, revision: { version, real } };
  }

  const match = QUALITIES.find((q) => q.source === source && q.resolution === resolution);
  return { qualityId: match?.id ?? 0, revision: { version, real } };
}

// ---------- release group ----------

export function parseReleaseGroup(name: string): string | undefined {
  const cleaned = name.replace(/\.(mkv|mp4|avi|m4v|ts)$/i, "");
  // trailing -GROUP (not a language/quality token)
  const m = cleaned.match(/-\s?([A-Za-z0-9]+)(?:\s*\[[^\]]+\])?$/);
  if (m) {
    const group = m[1];
    const stoplist = /^(480p|576p|720p|1080p|2160p|x264|x265|h264|h265|hevc|aac|ac3|dts|web|webdl|webrip|hdtv|bluray|repack|proper|internal|dl)$/i;
    if (!stoplist.test(group)) return group;
  }
  // [GROUP] prefix (common for anime; harmless otherwise)
  const bracket = cleaned.match(/^\[([^\]]+)\]/);
  if (bracket) return bracket[1];
  return undefined;
}

// ---------- embedded external ids ----------

export interface ExternalIds {
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
}

// Sonarr/Radarr/Jellyfin/Plex folder conventions embed provider ids in the name:
// "Title (2010) {tmdb-27205}", "Title [tvdbid-267440]", "Title {imdb-tt1375666}".
const EXTERNAL_ID_RE = /[[{]\s*(tmdb|tvdb|imdb)(?:id)?[-=\s]+(tt\d+|\d+)\s*[\]}]/gi;

/** Extract provider ids embedded in a release/folder name. */
export function parseExternalIds(name: string): ExternalIds {
  const ids: ExternalIds = {};
  for (const m of name.matchAll(EXTERNAL_ID_RE)) {
    const provider = m[1].toLowerCase();
    const value = m[2];
    if (provider === "imdb" && value.startsWith("tt")) ids.imdbId = value;
    else if (provider === "tmdb" && !value.startsWith("tt")) ids.tmdbId = parseInt(value, 10);
    else if (provider === "tvdb" && !value.startsWith("tt")) ids.tvdbId = parseInt(value, 10);
  }
  return ids;
}

/** Remove embedded id tags so they never pollute the parsed title. */
export function stripExternalIds(name: string): string {
  return name.replace(EXTERNAL_ID_RE, " ").replace(/\s{2,}/g, " ").trim();
}

// ---------- series / numbering ----------

interface NumberingMatch {
  titleEnd: number;
  seasons: number[];
  episodes: number[];
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

function matchNumbering(name: string): NumberingMatch | null {
  // S01E01, S01E01E02, S01E01-E03, S01E01-02
  let m = name.match(/\bS(\d{1,2})[. _-]?E(\d{1,3})(?:[-. _]?E?(\d{1,3}))*\b/i);
  if (m && m.index !== undefined) {
    const season = parseInt(m[1], 10);
    const episodes: number[] = [];
    const epMatches = m[0].matchAll(/E(\d{1,3})/gi);
    for (const em of epMatches) episodes.push(parseInt(em[1], 10));
    // dash range without E prefix: S01E01-03
    const dashRange = m[0].match(/E(\d{1,3})-(\d{1,3})$/i);
    if (dashRange && episodes.length === 1) {
      episodes.push(parseInt(dashRange[2], 10));
    }
    const eps =
      episodes.length === 2 && episodes[1] - episodes[0] > 1
        ? range(episodes[0], episodes[1])
        : [...new Set(episodes)].sort((a, b) => a - b);
    return { titleEnd: m.index, seasons: [season], episodes: eps };
  }

  // 1x01, 01x01
  m = name.match(/\b(\d{1,2})x(\d{2,3})\b/i);
  if (m && m.index !== undefined) {
    return { titleEnd: m.index, seasons: [parseInt(m[1], 10)], episodes: [parseInt(m[2], 10)] };
  }

  // multi-season pack: S01-S03
  m = name.match(/\bS(\d{1,2})[-. ]?S(\d{1,2})\b/i);
  if (m && m.index !== undefined) {
    return { titleEnd: m.index, seasons: range(parseInt(m[1], 10), parseInt(m[2], 10)), episodes: [] };
  }

  // season pack: S01 / Season 1
  m = name.match(/\b(?:S(\d{1,2})|Season[. _-]?(\d{1,2}))\b/i);
  if (m && m.index !== undefined) {
    return { titleEnd: m.index, seasons: [parseInt(m[1] ?? m[2], 10)], episodes: [] };
  }

  return null;
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/[._]/g, " ")
    .replace(/[-\s]+$/g, "")
    .replace(/^\[[^\]]+\]\s*/, "") // leading [group]
    .replace(/\s+/g, " ")
    .trim();
}

const YEAR_RE = /[(. _[-](19\d{2}|20\d{2})[). _\]-]/;

export function parseTitle(name: string): ParsedRelease {
  const originalTitle = name;
  const withoutExt = stripExternalIds(name.replace(/\.(mkv|mp4|avi|m4v|ts)$/i, ""));
  const quality = parseQuality(withoutExt);
  const releaseGroup = parseReleaseGroup(withoutExt);

  const numbering = matchNumbering(withoutExt);
  if (numbering) {
    let titlePart = withoutExt.slice(0, numbering.titleEnd);
    let year: number | undefined;
    const yearMatch = titlePart.match(YEAR_RE);
    if (yearMatch) {
      year = parseInt(yearMatch[1], 10);
      titlePart = titlePart.slice(0, yearMatch.index);
    }
    const title = cleanTitle(titlePart);
    return {
      originalTitle,
      title,
      normalizedTitle: normalizeTitle(title),
      year,
      seasons: numbering.seasons,
      episodes: numbering.episodes,
      isFullSeason: numbering.episodes.length === 0 && numbering.seasons.length === 1,
      isMultiSeason: numbering.seasons.length > 1,
      quality,
      releaseGroup,
      isTv: true,
    };
  }

  // movie: Title (Year) or Title.Year.
  const yearMatch = withoutExt.match(YEAR_RE);
  let title: string;
  let year: number | undefined;
  if (yearMatch && yearMatch.index !== undefined) {
    title = cleanTitle(withoutExt.slice(0, yearMatch.index));
    year = parseInt(yearMatch[1], 10);
  } else {
    // no year: strip from the first quality token onward
    let cut = withoutExt.length;
    for (const [re] of [...SOURCE_PATTERNS, ...RESOLUTION_PATTERNS] as [RegExp, unknown][]) {
      const m = withoutExt.match(re);
      if (m && m.index !== undefined && m.index < cut) cut = m.index;
    }
    title = cleanTitle(withoutExt.slice(0, cut));
  }

  return {
    originalTitle,
    title,
    normalizedTitle: normalizeTitle(title),
    year,
    seasons: [],
    episodes: [],
    isFullSeason: false,
    isMultiSeason: false,
    quality,
    releaseGroup,
    isTv: false,
  };
}
