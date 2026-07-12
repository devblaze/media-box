import type { TorznabItem, TorznabQuery } from "../torznab";
import { buildMagnet, fetchJson, queryTerm, type BuiltinDef } from "./types";

// apibay is The Pirate Bay's public JSON search API.
const SEARCH = "https://apibay.org/q.php";
const RECENT = "https://apibay.org/precompiled/data_top100_recent.json";

interface ApibayRow {
  id: string;
  name: string;
  info_hash: string;
  leechers: string;
  seeders: string;
  size: string;
  added: string;
  category: string;
}

// apibay category → Torznab category. 2xx = Video; 205/208 are TV, the rest movies.
function torznabCats(category: string): number[] {
  const c = Number(category);
  if (c === 205 || c === 208) return [5000];
  if (c >= 201 && c <= 299) return [2000];
  return [];
}

function isVideo(category: string): boolean {
  const c = Number(category);
  return c >= 200 && c < 300;
}

function toItem(row: ApibayRow): TorznabItem {
  const magnet = buildMagnet(row.info_hash, row.name);
  return {
    guid: row.info_hash,
    title: row.name,
    size: Number(row.size) || 0,
    link: magnet,
    magnetUrl: magnet,
    infoHash: row.info_hash.toLowerCase(),
    seeders: Number(row.seeders) || 0,
    leechers: Number(row.leechers) || 0,
    publishDate: row.added ? new Date(Number(row.added) * 1000).toUTCString() : undefined,
    categories: torznabCats(row.category),
  };
}

// apibay signals "nothing found" with a single sentinel row.
function isReal(row: ApibayRow): boolean {
  return row.id !== "0" && row.name !== "No results returned" && /[1-9a-f]/i.test(row.info_hash);
}

async function search(query: TorznabQuery): Promise<TorznabItem[]> {
  const term = queryTerm(query);
  if (!term) {
    // RSS mode: the recent feed, narrowed to video categories.
    const rows = await fetchJson<ApibayRow[]>(RECENT);
    return rows.filter((r) => isReal(r) && isVideo(r.category)).map(toItem);
  }
  // cat=200 = all Video (excludes audio/apps/games/porn); media-type is then
  // decided downstream by the release parser.
  const url = `${SEARCH}?q=${encodeURIComponent(term)}&cat=200`;
  const rows = await fetchJson<ApibayRow[]>(url);
  return rows.filter(isReal).map(toItem);
}

export const apibay: BuiltinDef = {
  key: "apibay",
  name: "The Pirate Bay",
  description: "Public movie & TV torrents via The Pirate Bay's apibay API. No account needed.",
  site: "https://thepiratebay.org",
  supportsTv: true,
  supportsMovies: true,
  categories: [5000, 5030, 5040, 2000, 2010, 2020, 2030, 2040, 2045, 2060],
  search,
};
