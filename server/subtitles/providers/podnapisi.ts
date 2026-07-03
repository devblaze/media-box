import { unzipSync } from "fflate";
import { decodeSubtitle } from "./codec";
import type { ProviderCandidate, ProviderSearchQuery, SubtitleProvider } from "./types";

/**
 * Podnapisi.NET — multi-language community subtitles (includes Greek), free / no
 * key. Downloads are ZIP archives (extracted with `fflate`).
 *
 * Strategy: hit the advanced-search endpoint asking for JSON; if that shape is
 * recognisable we read entries from it, otherwise we fall back to regex-scraping
 * `/subtitles/<slug>/download` links straight out of the (HTML or JSON) body.
 * Every network/parse/zip step is guarded so a failure yields `[]` rather than a
 * throw — the orchestrator then falls through to the next provider.
 */

const UA = "media-box/0.1";
const BASE = "https://www.podnapisi.net";
const SUB_EXTS = [".srt", ".ass", ".ssa", ".sub", ".vtt"];
const MAX_RESULTS = 20;

// ---- tiny defensive JSON helpers (no `any`) ---------------------------------

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const s = asString(obj[k]);
    if (s) return s;
  }
  return undefined;
}

/** Turn a possibly-relative download path into an absolute podnapisi URL. */
function absolutize(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return BASE + (path.startsWith("/") ? path : `/${path}`);
}

interface Hit {
  url: string; // absolute download (ZIP) url
  release: string;
  score: number;
  hearingImpaired: boolean;
}

/**
 * Fetch a download url. Podnapisi normally serves a ZIP; we detect the `PK`
 * magic and extract the first subtitle entry, otherwise we treat the body as a
 * raw subtitle file. Left multi-language (no forced encoding) so `decodeSubtitle`
 * defaults to UTF-8, which is what most podnapisi archives use.
 */
async function fetchSubtitle(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`podnapisi: download failed (HTTP ${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("podnapisi: empty download");
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    // ZIP archive.
    const files = unzipSync(buf);
    const name = Object.keys(files).find((n) =>
      SUB_EXTS.some((e) => n.toLowerCase().endsWith(e))
    );
    if (!name) throw new Error("podnapisi: no subtitle entry in archive");
    return decodeSubtitle(files[name]);
  }
  // Not a ZIP — assume a raw subtitle file.
  return decodeSubtitle(buf);
}

/** Read hits from a recognised JSON search response ({ data: [...] } or [...]). */
function hitsFromJson(body: string, wantHi: boolean | undefined): Hit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const root = asRecord(parsed);
  const rawList = Array.isArray(parsed)
    ? parsed
    : root && Array.isArray(root.data)
      ? root.data
      : root && Array.isArray(root.subtitles)
        ? root.subtitles
        : [];
  const hits: Hit[] = [];
  for (const raw of rawList) {
    const item = asRecord(raw);
    if (!item) continue;
    let dl = firstString(item, ["download"]);
    const page = firstString(item, ["url", "link"]);
    if (!dl && page) dl = `${page.replace(/\/+$/, "")}/download`;
    if (!dl) continue;

    const releases = item.releases;
    const release =
      (Array.isArray(releases)
        ? releases.map(asString).filter(Boolean).join(", ")
        : firstString(item, ["release", "title"])) ?? "";

    const stats = asRecord(item.stats);
    const score =
      (stats && asNumber(stats.downloads)) ?? asNumber(item.downloads) ?? 0;

    const flags = item.flags;
    const hearingImpaired =
      (Array.isArray(flags) && flags.some((f) => asString(f)?.toLowerCase() === "n")) ||
      item.hearing_impaired === true;
    if (wantHi === false && hearingImpaired) continue;

    hits.push({ url: absolutize(dl), release, score, hearingImpaired });
  }
  return hits;
}

/** Fallback: scrape `/subtitles/<slug>/download` links from any body text. */
function hitsFromScrape(body: string): Hit[] {
  const re = /\/subtitles\/([A-Za-z0-9\-_/]+?)\/download/g;
  const seen = new Set<string>();
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    hits.push({
      url: `${BASE}/subtitles/${slug}/download`,
      release: slug.split("/")[0] ?? slug,
      score: 0,
      hearingImpaired: false,
    });
  }
  return hits;
}

export const podnapisiProvider: SubtitleProvider = {
  id: "podnapisi",
  name: "Podnapisi.NET",
  description: "Community subtitles in many languages including Greek. Free, no API key.",
  needsConfig: false,
  specializes: [],
  isReady: () => true,
  async search(q: ProviderSearchQuery): Promise<ProviderCandidate[]> {
    try {
      if (!q.title) return [];
      const isEpisode = q.season != null && q.episode != null;

      const params = new URLSearchParams();
      params.set("keywords", q.title);
      if (q.year) params.set("year", String(q.year));
      params.set("sT", isEpisode ? "1" : "0");
      if (isEpisode) {
        params.set("sTS", String(q.season));
        params.set("sTE", String(q.episode));
      }
      // Podnapisi speaks ISO-639-1/2 directly — pass the 2-letter code through.
      params.set("sL", q.language);
      params.set("language", q.language);

      const url = `${BASE}/subtitles/search/advanced?${params.toString()}`;
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json, text/html" },
      });
      if (!res.ok) return [];
      const body = await res.text();
      if (!body) return [];

      let hits = hitsFromJson(body, q.hearingImpaired);
      if (hits.length === 0) hits = hitsFromScrape(body);
      if (hits.length === 0) return [];

      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, MAX_RESULTS).map((h) => ({
        providerId: "podnapisi",
        language: q.language,
        release: h.release,
        hearingImpaired: h.hearingImpaired,
        score: h.score,
        download: () => fetchSubtitle(h.url),
      }));
    } catch {
      return [];
    }
  },
};
