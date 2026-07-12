import type { TorznabItem, TorznabQuery } from "../torznab";

/**
 * A built-in indexer: a scraper that ships inside media-box and talks directly
 * to a public tracker's API, so no external Prowlarr/Jackett is required. Each
 * one returns the same `TorznabItem[]` shape the Torznab client produces, so the
 * rest of the pipeline (parse → score → dedupe → grab) is identical.
 */
export interface BuiltinDef {
  /** Stable registry key persisted in `indexers.definition` (e.g. "apibay"). */
  key: string;
  name: string;
  description: string;
  /** Homepage, shown in the UI. */
  site: string;
  supportsTv: boolean;
  supportsMovies: boolean;
  /** Default Torznab categories to store on the indexer row. */
  categories: number[];
  /** Run a search. An empty `query.q` means "recent releases" (RSS mode). */
  search(query: TorznabQuery): Promise<TorznabItem[]>;
}

const UA = "media-box/0.1";

/** GET + parse JSON with a bounded timeout and a friendly error on failure. */
export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`responded ${res.status}`);
  return (await res.json()) as T;
}

/** Fold season/episode into a plain-text search term for scrapers that only
 * take a free-text query (Torznab passes them as separate params). */
export function queryTerm(query: TorznabQuery): string {
  const parts = [query.q?.trim() ?? ""];
  if (query.season !== undefined) {
    let se = `S${String(query.season).padStart(2, "0")}`;
    if (query.ep !== undefined) se += `E${String(query.ep).padStart(2, "0")}`;
    parts.push(se);
  }
  return parts.filter(Boolean).join(" ").trim();
}

/** A small, stable set of public UDP trackers to make magnets connectable. */
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.tracker.cl:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.internetwarriors.net:1337/announce",
];

/** Build a magnet URI from an infohash + display name + optional extra trackers. */
export function buildMagnet(infoHash: string, name: string, extra: string[] = []): string {
  const params = new URLSearchParams();
  params.set("xt", `urn:btih:${infoHash}`);
  params.set("dn", name);
  const magnet = `magnet:?${params.toString()}`;
  const trackers = [...extra, ...TRACKERS]
    .map((t) => `&tr=${encodeURIComponent(t)}`)
    .join("");
  return magnet + trackers;
}
