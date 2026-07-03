import zlib from "node:zlib";
import { decodeSubtitle, imdbNumeric, iso6392 } from "./codec";
import type { ProviderCandidate, SubtitleProvider } from "./types";

const UA = "media-box v0.1";
const BASE = "https://rest.opensubtitles.org/search";

interface OrgResult {
  SubDownloadLink?: string; // gzipped subtitle
  MovieReleaseName?: string;
  SubDownloadsCnt?: string;
  SubHearingImpaired?: string; // "0" | "1"
  SubEncoding?: string;
}

async function downloadOrg(link: string, encoding?: string): Promise<string> {
  const res = await fetch(link, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`opensubtitles.org file fetch failed (HTTP ${res.status})`);
  const gz = new Uint8Array(await res.arrayBuffer());
  const raw = zlib.gunzipSync(gz);
  return decodeSubtitle(raw, encoding);
}

/**
 * OpenSubtitles.org legacy REST (rest.opensubtitles.org) — free, no API key.
 * Results download as gzip (handled by Node's zlib); Greek encodings honored.
 */
export const opensubtitlesOrgProvider: SubtitleProvider = {
  id: "opensubtitlesorg",
  name: "OpenSubtitles.org (legacy, free)",
  description:
    "The classic OpenSubtitles.org database — free and no API key. Broad language coverage including Greek.",
  needsConfig: false,
  isReady: () => true,
  async search(q) {
    const parts: string[] = [];
    const imdb = imdbNumeric(q.season != null ? q.parentImdbId : q.imdbId);
    if (imdb) parts.push(`imdbid-${imdb}`);
    else if (q.title) parts.push(`query-${encodeURIComponent(q.title)}`);
    else return [];
    if (q.season != null && q.episode != null) {
      parts.push(`season-${q.season}`, `episode-${q.episode}`);
    }
    parts.push(`sublanguageid-${iso6392(q.language)}`);

    let data: OrgResult[];
    try {
      const res = await fetch(`${BASE}/${parts.join("/")}`, {
        headers: { "User-Agent": UA, "X-User-Agent": UA, Accept: "application/json" },
      });
      if (!res.ok) return [];
      const json = await res.json();
      data = Array.isArray(json) ? (json as OrgResult[]) : [];
    } catch {
      return [];
    }

    const out: ProviderCandidate[] = [];
    for (const r of data) {
      if (!r.SubDownloadLink) continue;
      const hi = r.SubHearingImpaired === "1";
      if (q.hearingImpaired === false && hi) continue;
      const link = r.SubDownloadLink;
      const enc = r.SubEncoding;
      out.push({
        providerId: "opensubtitlesorg",
        language: q.language,
        release: r.MovieReleaseName ?? "",
        hearingImpaired: hi,
        score: Number(r.SubDownloadsCnt) || 0,
        download: () => downloadOrg(link, enc),
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  },
};
