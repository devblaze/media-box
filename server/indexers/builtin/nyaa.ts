import { XMLParser } from "fast-xml-parser";
import type { TorznabItem, TorznabQuery } from "../torznab";
import { buildMagnet, queryTerm, type BuiltinDef } from "./types";

// Nyaa exposes search + recent as an RSS feed with `nyaa:`-namespaced fields.
const BASE = "https://nyaa.si/";

const parser = new XMLParser({ ignoreAttributes: true, isArray: (name) => name === "item" });

interface NyaaItem {
  title?: string;
  link?: string;
  guid?: string;
  pubDate?: string;
  "nyaa:seeders"?: number | string;
  "nyaa:leechers"?: number | string;
  "nyaa:infoHash"?: string;
  "nyaa:size"?: string;
}

const UNITS: Record<string, number> = {
  B: 1,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
};

// Nyaa reports size as a human string like "628.9 MiB".
function parseSize(size: string | undefined): number {
  if (!size) return 0;
  const m = size.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!m) return 0;
  return Math.round(parseFloat(m[1]) * (UNITS[m[2].toUpperCase()] ?? 1));
}

async function search(query: TorznabQuery): Promise<TorznabItem[]> {
  const term = queryTerm(query);
  const url = new URL(BASE);
  url.searchParams.set("page", "rss");
  url.searchParams.set("c", "1_0"); // all Anime
  url.searchParams.set("f", "0"); // no filter
  if (term) url.searchParams.set("q", term);

  const res = await fetch(url.toString(), {
    cache: "no-store",
    headers: { "User-Agent": "media-box/0.1" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`responded ${res.status}`);
  const doc = parser.parse(await res.text()) as { rss?: { channel?: { item?: NyaaItem[] } } };
  const items = doc.rss?.channel?.item ?? [];

  return items
    .filter((i): i is NyaaItem & { title: string } => Boolean(i.title))
    .map((i) => {
      const hash = String(i["nyaa:infoHash"] ?? "").toLowerCase();
      // Prefer a magnet built from the infohash; fall back to the .torrent link.
      const magnet = hash ? buildMagnet(hash, i.title) : undefined;
      return {
        guid: i.guid ? String(i.guid) : hash || i.title,
        title: i.title,
        size: parseSize(i["nyaa:size"]),
        link: magnet ?? i.link ?? "",
        magnetUrl: magnet,
        infoHash: hash || undefined,
        seeders: i["nyaa:seeders"] !== undefined ? Number(i["nyaa:seeders"]) : null,
        leechers: i["nyaa:leechers"] !== undefined ? Number(i["nyaa:leechers"]) : null,
        publishDate: i.pubDate,
        categories: [5000],
      };
    });
}

export const nyaa: BuiltinDef = {
  key: "nyaa",
  name: "Nyaa",
  description: "Anime torrents (subs & raws) from Nyaa.si. No account needed.",
  site: "https://nyaa.si",
  supportsTv: true,
  supportsMovies: false,
  categories: [5000, 5030, 5040],
  search,
};
