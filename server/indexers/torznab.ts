import { XMLParser } from "fast-xml-parser";

export interface TorznabCaps {
  searchAvailable: boolean;
  tvSearchAvailable: boolean;
  movieSearchAvailable: boolean;
  categories: { id: number; name: string }[];
}

export interface TorznabItem {
  guid: string;
  title: string;
  size: number;
  link: string;
  magnetUrl?: string;
  infoHash?: string;
  seeders: number | null;
  leechers: number | null;
  publishDate?: string;
  categories: number[];
}

export interface TorznabQuery {
  t: "search" | "tvsearch" | "movie";
  q?: string;
  season?: number;
  ep?: number;
  cat?: number[];
  limit?: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => name === "item" || name === "torznab:attr" || name === "category",
});

function buildUrl(baseUrl: string, apiKey: string | null, params: Record<string, string>): string {
  const url = new URL(baseUrl.includes("/api") ? baseUrl : `${baseUrl.replace(/\/$/, "")}/api`);
  if (apiKey) url.searchParams.set("apikey", apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function fetchXml(url: string): Promise<unknown> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": "media-box/0.1" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Indexer responded ${res.status}`);
  const text = await res.text();
  const doc = parser.parse(text);
  if (doc.error) {
    throw new Error(`Torznab error ${doc.error["@_code"]}: ${doc.error["@_description"]}`);
  }
  return doc;
}

export async function getCaps(baseUrl: string, apiKey: string | null): Promise<TorznabCaps> {
  const doc = (await fetchXml(buildUrl(baseUrl, apiKey, { t: "caps" }))) as {
    caps?: {
      searching?: {
        search?: { "@_available"?: string };
        "tv-search"?: { "@_available"?: string };
        "movie-search"?: { "@_available"?: string };
      };
      categories?: { category?: { "@_id": string; "@_name": string }[] };
    };
  };
  const caps = doc.caps;
  if (!caps) throw new Error("Indexer did not return caps");
  const searching = caps.searching ?? {};
  const categories = (caps.categories?.category ?? []).map((c) => ({
    id: Number(c["@_id"]),
    name: c["@_name"],
  }));
  return {
    searchAvailable: searching.search?.["@_available"] !== "no",
    tvSearchAvailable: searching["tv-search"]?.["@_available"] === "yes",
    movieSearchAvailable: searching["movie-search"]?.["@_available"] === "yes",
    categories,
  };
}

interface RawItem {
  guid?: string | { "#text"?: string };
  title?: string;
  size?: number | string;
  link?: string;
  pubDate?: string;
  category?: (string | number)[];
  "torznab:attr"?: { "@_name": string; "@_value": string }[];
  enclosure?: { "@_url"?: string };
}

function attrMap(item: RawItem): Map<string, string> {
  const map = new Map<string, string>();
  for (const attr of item["torznab:attr"] ?? []) {
    map.set(attr["@_name"], attr["@_value"]);
  }
  return map;
}

export async function search(
  baseUrl: string,
  apiKey: string | null,
  query: TorznabQuery
): Promise<TorznabItem[]> {
  const params: Record<string, string> = { t: query.t };
  if (query.q) params.q = query.q;
  if (query.season !== undefined) params.season = String(query.season);
  if (query.ep !== undefined) params.ep = String(query.ep);
  if (query.cat?.length) params.cat = query.cat.join(",");
  params.limit = String(query.limit ?? 100);

  const doc = (await fetchXml(buildUrl(baseUrl, apiKey, params))) as {
    rss?: { channel?: { item?: RawItem[] } };
  };
  const items = doc.rss?.channel?.item ?? [];

  return items
    .filter((i): i is RawItem & { title: string } => Boolean(i.title))
    .map((item) => {
      const attrs = attrMap(item);
      const guid = typeof item.guid === "object" ? (item.guid["#text"] ?? "") : (item.guid ?? "");
      const magnet = attrs.get("magneturl");
      const link = item.link ?? item.enclosure?.["@_url"] ?? "";
      return {
        guid: guid || link,
        title: item.title,
        size: Number(attrs.get("size") ?? item.size ?? 0),
        link,
        magnetUrl: magnet ?? (link.startsWith("magnet:") ? link : undefined),
        infoHash: attrs.get("infohash")?.toLowerCase(),
        seeders: attrs.has("seeders") ? Number(attrs.get("seeders")) : null,
        leechers: attrs.has("peers") ? Number(attrs.get("peers")) : null,
        publishDate: item.pubDate,
        categories: (item.category ?? [])
          .map((c) => Number(c))
          .filter((c) => Number.isFinite(c)),
      };
    });
}
