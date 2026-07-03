import { getSettings } from "@/server/settings/settings-service";
import { searchSubtitles, downloadSubtitle } from "../opensubtitles";
import type { SubtitleProvider } from "./types";

/** OpenSubtitles.com (REST v1) — the largest source; needs a free API key. */
export const opensubtitlesProvider: SubtitleProvider = {
  id: "opensubtitles",
  name: "OpenSubtitles.com",
  description:
    "The biggest multi-language database (includes Greek). Needs a free API key, plus a username/password to download.",
  needsConfig: true,
  isReady: () => !!getSettings().openSubtitlesApiKey,
  async search(q) {
    try {
      const cands = await searchSubtitles({
        language: q.language,
        imdbId: q.imdbId,
        tmdbId: q.tmdbId,
        season: q.season,
        episode: q.episode,
        parentImdbId: q.parentImdbId,
        parentTmdbId: q.parentTmdbId,
        hearingImpaired: q.hearingImpaired,
      });
      return cands.map((c) => ({
        providerId: "opensubtitles",
        language: c.language,
        release: c.release,
        hearingImpaired: c.hearingImpaired,
        score: (c.fromTrusted ? 1_000_000 : 0) + c.downloadCount,
        download: () => downloadSubtitle(c.fileId),
      }));
    } catch {
      return [];
    }
  },
};
