import { unzipSync } from "fflate";
import { decodeSubtitle } from "./codec";
import type { ProviderCandidate, ProviderSearchQuery, SubtitleProvider } from "./types";

/**
 * subs4free.club — a Greek subtitles community site. Free, no key. HTML pages +
 * ZIP downloads; Greek text is almost always windows-1253, so every decode uses
 * that hint (codec.decodeSubtitle falls back to UTF-8 if it is wrong).
 *
 * Best-effort scraper: search the site for the title, collect candidate
 * subtitle/detail links, rank them by how well their label matches the query,
 * and — at download time — follow one level of indirection (detail page → ZIP)
 * if needed. Every network/parse/zip step is guarded so failures yield `[]`
 * (search) or a caught throw (download) rather than crashing the app.
 */

const UA = "media-box/0.1";
const BASE = "https://subs4free.club";
const ENC = "windows-1253";
const SUB_EXTS = [".srt", ".ass", ".ssa", ".sub", ".vtt"];
const MAX_RESULTS = 15;

/** Turn a possibly-relative href into an absolute subs4free URL. */
function absolutize(href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  return BASE + (href.startsWith("/") ? href : `/${href}`);
}

/** Lowercase, strip Greek/latin accents and punctuation → space-separated tokens. */
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Extract the first plausible archive/subtitle link out of a detail page. */
function extractDownloadLink(html: string): string | undefined {
  const patterns = [
    /href="([^"]*getSubtitle\.php\?[^"]*)"/i,
    /href="([^"]*download[^"]*\.php\?[^"]*)"/i,
    /href="([^"]*\.(?:zip|rar))"/i,
    /href="([^"]*\.(?:srt|ass|ssa|sub|vtt))"/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1];
  }
  return undefined;
}

/** Decode a fetched buffer: unzip if it is a ZIP, else treat it as a raw sub. */
function fromArchiveOrRaw(buf: Uint8Array): string {
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const files = unzipSync(buf);
    const name = Object.keys(files).find((n) =>
      SUB_EXTS.some((e) => n.toLowerCase().endsWith(e))
    );
    if (!name) throw new Error("subs4free: no subtitle entry in archive");
    return decodeSubtitle(files[name], ENC);
  }
  return decodeSubtitle(buf, ENC);
}

/** Detect an HTML body (so we can follow its download link instead of decoding). */
function looksLikeHtml(buf: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(buf.subarray(0, 512)).toLowerCase();
  return /<!doctype|<html|<head|<body|<a\s/i.test(head);
}

/**
 * Fetch a subtitle starting from a search-result href. If it is a ZIP we extract
 * it; if it is a raw subtitle we decode it; if it is an HTML detail page we scrape
 * the real download link and fetch that (one hop only). Greek → windows-1253.
 */
async function fetchDownload(startUrl: string): Promise<string> {
  const res = await fetch(startUrl, {
    headers: { "User-Agent": UA, Referer: `${BASE}/` },
  });
  if (!res.ok) throw new Error(`subs4free: fetch failed (HTTP ${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("subs4free: empty response");

  if (buf[0] === 0x50 && buf[1] === 0x4b) return fromArchiveOrRaw(buf);

  if (looksLikeHtml(buf)) {
    const html = decodeSubtitle(buf, "utf-8");
    const link = extractDownloadLink(html);
    if (!link) throw new Error("subs4free: no download link on page");
    const res2 = await fetch(absolutize(link), {
      headers: { "User-Agent": UA, Referer: startUrl },
    });
    if (!res2.ok) throw new Error(`subs4free: archive fetch failed (HTTP ${res2.status})`);
    const buf2 = new Uint8Array(await res2.arrayBuffer());
    if (buf2.length === 0) throw new Error("subs4free: empty archive");
    return fromArchiveOrRaw(buf2);
  }

  // Not a ZIP, not HTML — assume a raw subtitle file.
  return fromArchiveOrRaw(buf);
}

interface Anchor {
  href: string;
  label: string;
}

/** Pull anchors that plausibly point at a subtitle detail/download link. */
function subtitleAnchors(html: string): Anchor[] {
  const re = /<a\b([^>]*?)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi;
  const out: Anchor[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const before = m[1];
    const href = m[2];
    const after = m[3];
    const inner = m[4];
    const low = href.toLowerCase();
    const isSubLink =
      /getsubtitle\.php|download|\/subtitle|subs4free\.club\/[^"']+\.html|\.html$/i.test(low) &&
      !/(index|contact|about|login|register|rss|category|search_report)\b/i.test(low);
    if (!isSubLink) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const titleAttr =
      /title="([^"]*)"/i.exec(before)?.[1] ?? /title="([^"]*)"/i.exec(after)?.[1] ?? "";
    out.push({ href, label: `${titleAttr} ${inner}` });
  }
  return out;
}

export const subs4freeProvider: SubtitleProvider = {
  id: "subs4free",
  name: "Subs4Free (Greek)",
  description: "Greek subtitles community (subs4free.club). Free, no key. Best for Greek content.",
  needsConfig: false,
  specializes: ["el"],
  isReady: () => true,
  async search(q: ProviderSearchQuery): Promise<ProviderCandidate[]> {
    try {
      if (!q.title) return [];
      const isEpisode = q.season != null && q.episode != null;

      const term = isEpisode
        ? `${q.title} S${pad2(q.season as number)}E${pad2(q.episode as number)}`
        : q.year
          ? `${q.title} ${q.year}`
          : q.title;

      const url = `${BASE}/search_report.php?search=${encodeURIComponent(term)}`;
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html", Referer: `${BASE}/` },
      });
      if (!res.ok) return [];
      const html = decodeSubtitle(new Uint8Array(await res.arrayBuffer()), ENC);
      if (!html) return [];

      const anchors = subtitleAnchors(html);
      if (anchors.length === 0) return [];

      // Score anchors by how many query tokens appear in their label.
      const titleTokens = normalize(q.title).split(" ").filter((t) => t.length > 1);
      const yearStr = q.year ? String(q.year) : "";
      const sxe = isEpisode ? `s${pad2(q.season as number)}e${pad2(q.episode as number)}` : "";

      const scored = anchors.map((a) => {
        const label = normalize(a.label);
        let score = 0;
        for (const t of titleTokens) if (label.includes(t)) score += 2;
        if (yearStr && label.includes(yearStr)) score += 3;
        if (sxe && label.replace(/\s+/g, "").includes(sxe)) score += 5;
        return { anchor: a, score };
      });
      scored.sort((a, b) => b.score - a.score);

      return scored.slice(0, MAX_RESULTS).map(({ anchor, score }) => ({
        providerId: "subs4free",
        language: q.language,
        release: anchor.label.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
        hearingImpaired: false,
        score,
        download: () => fetchDownload(absolutize(anchor.href)),
      }));
    } catch {
      return [];
    }
  },
};
