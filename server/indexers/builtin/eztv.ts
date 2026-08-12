import type { TorznabItem, TorznabQuery } from "../torznab";
import { fetchJson, queryTerm, type BuiltinDef } from "./types";

// EZTV's public JSON API. It has no free-text search — only recent pages (and
// imdb filtering) — so text queries fetch a few recent pages and filter by
// title. That covers the common case (currently-airing episodes) well.
const API = "https://eztvx.to/api/get-torrents";
const PAGE_SIZE = 100;
const SEARCH_PAGES = 3;

interface EztvTorrent {
  hash?: string;
  title?: string;
  magnet_url?: string;
  torrent_url?: string;
  seeds?: number;
  peers?: number;
  size_bytes?: string | number;
  date_released_unix?: number;
}

interface EztvResponse {
  torrents?: EztvTorrent[];
}

function toItem(t: EztvTorrent): TorznabItem | null {
  const title = t.title?.trim();
  const link = t.magnet_url || t.torrent_url;
  if (!title || !link) return null;
  return {
    guid: t.hash?.toLowerCase() || link,
    title,
    size: Number(t.size_bytes) || 0,
    link,
    magnetUrl: t.magnet_url,
    infoHash: t.hash?.toLowerCase(),
    seeders: t.seeds ?? null,
    leechers: t.peers ?? null,
    publishDate: t.date_released_unix
      ? new Date(t.date_released_unix * 1000).toISOString()
      : undefined,
    categories: [5000],
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function page(p: number): Promise<EztvTorrent[]> {
  const res = await fetchJson<EztvResponse>(`${API}?limit=${PAGE_SIZE}&page=${p}`);
  return res.torrents ?? [];
}

async function search(query: TorznabQuery): Promise<TorznabItem[]> {
  const term = norm(queryTerm(query));
  if (!term) {
    // RSS mode: one page of the newest releases.
    return (await page(1)).map(toItem).filter((x): x is TorznabItem => x !== null);
  }
  // Text search: scan a few recent pages and keep title matches.
  const pages = await Promise.all(
    Array.from({ length: SEARCH_PAGES }, (_, i) => page(i + 1).catch(() => []))
  );
  return pages
    .flat()
    .map(toItem)
    .filter((x): x is TorznabItem => x !== null && norm(x.title).includes(term));
}

export const eztv: BuiltinDef = {
  key: "eztv",
  name: "EZTV",
  description: "TV episode releases via the EZTV JSON API (best for currently-airing shows).",
  site: "https://eztvx.to",
  supportsTv: true,
  supportsMovies: false,
  categories: [5000, 5030, 5040],
  search,
};
