/**
 * Minimal OpenSubtitles.com REST client (api.opensubtitles.com/api/v1).
 *
 * Auth model: every request sends the account `Api-Key`. Downloading a file also
 * requires a bearer token obtained from POST /login with the account username +
 * password; the token is cached in-process until the app restarts.
 */
import { getSettings } from "@/server/settings/settings-service";

const BASE = "https://api.opensubtitles.com/api/v1";
const USER_AGENT = "media-box v0.1";

export interface SubtitleCandidate {
  fileId: number;
  language: string;
  release: string;
  downloadCount: number;
  hearingImpaired: boolean;
  fromTrusted: boolean;
}

export class OpenSubtitlesError extends Error {}

function creds() {
  const s = getSettings();
  if (!s.openSubtitlesApiKey) {
    throw new OpenSubtitlesError("OpenSubtitles is not configured (Settings → Subtitles).");
  }
  return {
    apiKey: s.openSubtitlesApiKey,
    username: s.openSubtitlesUsername,
    password: s.openSubtitlesPassword,
  };
}

function headers(apiKey: string, token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Api-Key": apiKey,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// Cached login token (valid until process restart / OpenSubtitles expiry ~24h).
let cachedToken: { key: string; token: string } | null = null;

async function login(): Promise<string> {
  const { apiKey, username, password } = creds();
  if (!username || !password) {
    throw new OpenSubtitlesError("OpenSubtitles username/password required to download subtitles.");
  }
  if (cachedToken?.key === apiKey) return cachedToken.token;

  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new OpenSubtitlesError(`OpenSubtitles login failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new OpenSubtitlesError("OpenSubtitles login returned no token");
  cachedToken = { key: apiKey, token: body.token };
  return body.token;
}

export interface SearchQuery {
  language: string;
  imdbId?: string | null; // "tt1234567" or "1234567"
  tmdbId?: number | null;
  /** For episodes: the parent series ids + the episode coordinates. */
  season?: number;
  episode?: number;
  parentImdbId?: string | null;
  parentTmdbId?: number | null;
  hearingImpaired?: boolean;
}

function imdbNumeric(id?: string | null): string | undefined {
  if (!id) return undefined;
  const n = id.replace(/^tt/i, "").replace(/\D/g, "");
  return n || undefined;
}

/** Search subtitles; returns candidates ranked by download count (best first). */
export async function searchSubtitles(q: SearchQuery): Promise<SubtitleCandidate[]> {
  const { apiKey } = creds();
  const params = new URLSearchParams({ languages: q.language });

  if (q.season != null && q.episode != null) {
    params.set("season_number", String(q.season));
    params.set("episode_number", String(q.episode));
    const pImdb = imdbNumeric(q.parentImdbId);
    if (pImdb) params.set("parent_imdb_id", pImdb);
    else if (q.parentTmdbId) params.set("parent_tmdb_id", String(q.parentTmdbId));
  } else {
    const imdb = imdbNumeric(q.imdbId);
    if (imdb) params.set("imdb_id", imdb);
    else if (q.tmdbId) params.set("tmdb_id", String(q.tmdbId));
  }
  if (q.hearingImpaired === false) params.set("hearing_impaired", "exclude");

  const res = await fetch(`${BASE}/subtitles?${params.toString()}`, { headers: headers(apiKey) });
  if (!res.ok) throw new OpenSubtitlesError(`OpenSubtitles search failed (HTTP ${res.status})`);

  const body = (await res.json()) as {
    data?: Array<{
      attributes?: {
        language?: string;
        release?: string;
        download_count?: number;
        hearing_impaired?: boolean;
        from_trusted?: boolean;
        files?: Array<{ file_id?: number }>;
      };
    }>;
  };

  const out: SubtitleCandidate[] = [];
  for (const item of body.data ?? []) {
    const a = item.attributes;
    const fileId = a?.files?.[0]?.file_id;
    if (!a || !fileId) continue;
    out.push({
      fileId,
      language: a.language ?? q.language,
      release: a.release ?? "",
      downloadCount: a.download_count ?? 0,
      hearingImpaired: a.hearing_impaired ?? false,
      fromTrusted: a.from_trusted ?? false,
    });
  }
  // Prefer trusted uploads, then most-downloaded.
  out.sort((x, y) => Number(y.fromTrusted) - Number(x.fromTrusted) || y.downloadCount - x.downloadCount);
  return out;
}

/** Resolve a file_id to the subtitle text content (SRT). */
export async function downloadSubtitle(fileId: number): Promise<string> {
  const { apiKey } = creds();
  const token = await login();

  const res = await fetch(`${BASE}/download`, {
    method: "POST",
    headers: headers(apiKey, token),
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!res.ok) throw new OpenSubtitlesError(`OpenSubtitles download request failed (HTTP ${res.status})`);
  const body = (await res.json()) as { link?: string };
  if (!body.link) throw new OpenSubtitlesError("OpenSubtitles download returned no link");

  const file = await fetch(body.link, { headers: { "User-Agent": USER_AGENT } });
  if (!file.ok) throw new OpenSubtitlesError(`Subtitle file fetch failed (HTTP ${file.status})`);
  return file.text();
}
