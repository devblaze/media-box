import type { TorznabItem, TorznabQuery } from "../torznab";
import { buildMagnet, fetchJson, queryTerm, type BuiltinDef } from "./types";

// YTS publishes a stable JSON API for its (movie-only) catalog.
const API = "https://yts.mx/api/v2/list_movies.json";

interface YtsTorrent {
  hash: string;
  quality: string; // "720p" | "1080p" | "2160p" | "3D"
  type: string; // "web" | "bluray"
  size_bytes: number;
  seeds: number;
  peers: number;
  date_uploaded: string;
}

interface YtsMovie {
  title_long: string; // "Movie Title (2020)"
  torrents?: YtsTorrent[];
}

interface YtsResponse {
  status: string;
  data?: { movies?: YtsMovie[] };
}

function toItems(movie: YtsMovie): TorznabItem[] {
  return (movie.torrents ?? []).map((t) => {
    // Compose a scene-style name the release parser understands.
    const source = t.type === "bluray" ? "BluRay" : "WEB";
    const title = `${movie.title_long} [${t.quality}] [${source}] [YTS]`
      .replace(/\s+/g, " ")
      .trim();
    const magnet = buildMagnet(t.hash, title);
    return {
      guid: t.hash.toLowerCase(),
      title,
      size: t.size_bytes || 0,
      link: magnet,
      magnetUrl: magnet,
      infoHash: t.hash.toLowerCase(),
      seeders: t.seeds ?? null,
      leechers: t.peers ?? null,
      publishDate: t.date_uploaded,
      categories: [2000],
    };
  });
}

async function search(query: TorznabQuery): Promise<TorznabItem[]> {
  const url = new URL(API);
  const term = queryTerm(query);
  if (term) url.searchParams.set("query_term", term);
  url.searchParams.set("limit", String(Math.min(query.limit ?? 50, 50)));
  url.searchParams.set("sort_by", term ? "seeds" : "date_added");
  const res = await fetchJson<YtsResponse>(url.toString());
  if (res.status !== "ok") throw new Error("YTS API returned an error");
  return (res.data?.movies ?? []).flatMap(toItems);
}

export const yts: BuiltinDef = {
  key: "yts",
  name: "YTS",
  description: "Movie releases (720p/1080p/2160p, small encodes) via the official YTS JSON API.",
  site: "https://yts.mx",
  supportsTv: false,
  supportsMovies: true,
  categories: [2000, 2010, 2020, 2030, 2040, 2045, 2060],
  search,
};
