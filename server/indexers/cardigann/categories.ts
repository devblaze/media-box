import type { CapsBlock } from "./types";

/**
 * The standard Newznab/Torznab category tree, keyed by the NAMES that Cardigann
 * YAML files use in `caps.categorymappings[].cat` (e.g. "Movies/HD"). The ids
 * match Jackett's TorznabCatType so grabbed categories line up with what the
 * rest of media-box expects from external Torznab indexers.
 */
const TORZNAB_CATEGORY_IDS: Record<string, number> = {
  console: 1000,
  "console/nds": 1010,
  "console/psp": 1020,
  "console/wii": 1030,
  "console/xbox": 1040,
  "console/xbox 360": 1050,
  "console/wiiware": 1060,
  "console/xbox 360 dlc": 1070,
  "console/ps3": 1080,
  "console/other": 1090,
  "console/3ds": 1110,
  "console/ps vita": 1120,
  "console/wiiu": 1130,
  "console/xbox one": 1140,
  "console/ps4": 1180,
  movies: 2000,
  "movies/foreign": 2010,
  "movies/other": 2020,
  "movies/sd": 2030,
  "movies/hd": 2040,
  "movies/uhd": 2045,
  "movies/bluray": 2050,
  "movies/3d": 2060,
  "movies/dvd": 2070,
  "movies/web-dl": 2080,
  audio: 3000,
  "audio/mp3": 3010,
  "audio/video": 3020,
  "audio/audiobook": 3030,
  "audio/lossless": 3040,
  "audio/other": 3050,
  "audio/foreign": 3060,
  pc: 4000,
  "pc/0day": 4010,
  "pc/iso": 4020,
  "pc/mac": 4030,
  "pc/mobile-other": 4040,
  "pc/games": 4050,
  "pc/mobile-ios": 4060,
  "pc/mobile-android": 4070,
  tv: 5000,
  "tv/web-dl": 5010,
  "tv/foreign": 5020,
  "tv/sd": 5030,
  "tv/hd": 5040,
  "tv/uhd": 5045,
  "tv/other": 5050,
  "tv/sport": 5060,
  "tv/anime": 5070,
  "tv/documentary": 5080,
  xxx: 6000,
  "xxx/dvd": 6010,
  "xxx/wmv": 6020,
  "xxx/xvid": 6030,
  "xxx/x264": 6040,
  "xxx/uhd": 6045,
  "xxx/pack": 6050,
  "xxx/imageset": 6060,
  "xxx/other": 6070,
  "xxx/sd": 6080,
  "xxx/web-dl": 6090,
  books: 7000,
  "books/mags": 7010,
  "books/ebook": 7020,
  "books/comics": 7030,
  "books/technical": 7040,
  "books/other": 7050,
  "books/foreign": 7060,
  other: 8000,
  "other/misc": 8010,
  "other/hashed": 8020,
};

/** Torznab category name (as written in YAML) → numeric id, or null if unknown. */
export function torznabCategoryId(name: string): number | null {
  return TORZNAB_CATEGORY_IDS[name.trim().toLowerCase()] ?? null;
}

/** One resolved mapping: tracker-side id ↔ numeric Torznab category. */
export interface ResolvedMapping {
  trackerId: string;
  torznabId: number;
}

/**
 * Flatten a caps block into tracker↔Torznab pairs. Both the modern
 * `categorymappings` list and the legacy `categories` dict are honored;
 * mappings with unknown Torznab names are dropped (better a missing category
 * than a wrong one).
 */
export function resolveMappings(caps: CapsBlock | undefined): ResolvedMapping[] {
  const out: ResolvedMapping[] = [];
  for (const m of caps?.categorymappings ?? []) {
    const id = torznabCategoryId(m.cat);
    if (id !== null) out.push({ trackerId: String(m.id), torznabId: id });
  }
  for (const [trackerId, cat] of Object.entries(caps?.categories ?? {})) {
    const id = torznabCategoryId(cat);
    if (id !== null) out.push({ trackerId, torznabId: id });
  }
  return out;
}

/** Is `queryCat` a match for `cat`? Parent ids (x000) match all children. */
function categoryMatches(queryCat: number, cat: number): boolean {
  if (queryCat === cat) return true;
  return queryCat % 1000 === 0 && Math.floor(cat / 1000) === Math.floor(queryCat / 1000);
}

/**
 * Map Torznab query categories to the tracker's own ids. A parent category in
 * the query (e.g. 5000 TV) selects every tracker category mapped to any 5xxx.
 */
export function trackerCategoriesFor(mappings: ResolvedMapping[], queryCats: number[]): string[] {
  const out: string[] = [];
  for (const m of mappings) {
    if (queryCats.some((qc) => categoryMatches(qc, m.torznabId)) && !out.includes(m.trackerId)) {
      out.push(m.trackerId);
    }
  }
  return out;
}

/**
 * Map a tracker category value scraped from a result row back to Torznab ids.
 * Comparison is case-insensitive because sites are sloppy about casing.
 */
export function torznabCategoriesFor(mappings: ResolvedMapping[], trackerCat: string): number[] {
  const needle = trackerCat.trim().toLowerCase();
  const out: number[] = [];
  for (const m of mappings) {
    if (m.trackerId.toLowerCase() === needle && !out.includes(m.torznabId)) {
      out.push(m.torznabId);
    }
  }
  return out;
}
