// Minimal Jellyfin REST client for the per-user watch-state sync. Follows the
// arr-client conventions: typed responses, 30s timeout, 401 → human message.

export class JellyfinError extends Error {}

export interface JellyfinConnection {
  url: string;
  /** Jellyfin user id the token belongs to. */
  userId: string;
  accessToken: string;
  deviceId: string;
}

export interface JellyfinUserData {
  PlaybackPositionTicks?: number;
  Played?: boolean;
  LastPlayedDate?: string;
}

export interface JellyfinItem {
  Id: string;
  Name?: string;
  Type?: string; // "Movie" | "Episode" | "Series" | ...
  ProviderIds?: Record<string, string>; // keys: Tmdb, Tvdb, Imdb (casing varies)
  RunTimeTicks?: number;
  SeriesId?: string;
  SeriesName?: string;
  /** Season number (episodes). */
  ParentIndexNumber?: number;
  /** Episode number (episodes). */
  IndexNumber?: number;
  UserData?: JellyfinUserData;
}

export interface JellyfinAuthResult {
  User: { Id: string; Name: string };
  AccessToken: string;
}

/** Ticks are 100ns units: 10,000,000 per second. */
export function ticksToSeconds(ticks: number | undefined | null): number {
  return ticks ? Math.floor(ticks / 10_000_000) : 0;
}

/** Case-insensitive ProviderIds lookup ("Tmdb" vs "tmdb" varies by server). */
export function providerId(item: JellyfinItem, provider: string): string | null {
  const ids = item.ProviderIds;
  if (!ids) return null;
  const key = Object.keys(ids).find((k) => k.toLowerCase() === provider.toLowerCase());
  const value = key ? ids[key]?.trim() : "";
  return value ? value : null;
}

/**
 * MediaBrowser auth scheme. The header (with the same DeviceId) is required both
 * to obtain a token and on every authenticated call afterwards.
 */
function authHeader(deviceId: string, token?: string): string {
  const parts = [
    'MediaBrowser Client="media-box"',
    'Device="media-box"',
    `DeviceId="${deviceId}"`,
    'Version="1.0"',
  ];
  if (token) parts.push(`Token="${token}"`);
  return parts.join(", ");
}

async function jfFetch<T>(
  url: string,
  path: string,
  deviceId: string,
  token: string | undefined,
  init?: RequestInit
): Promise<T> {
  const base = url.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: authHeader(deviceId, token),
        "Content-Type": "application/json",
        ...init?.headers,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new JellyfinError(
      `Could not reach Jellyfin at ${base}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (res.status === 401) {
    throw new JellyfinError(
      "Jellyfin rejected the credentials (401) — wrong login, or the link needs reconnecting."
    );
  }
  if (!res.ok) {
    throw new JellyfinError(`Jellyfin ${path} responded ${res.status}`);
  }
  // Some endpoints (e.g. Sessions/Logout) return an empty body.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Public server info — no auth needed; used by the admin "Test" button. */
export function getPublicSystemInfo(url: string) {
  return jfFetch<{ ServerName?: string; Version?: string }>(
    url,
    "/System/Info/Public",
    "media-box-test",
    undefined
  );
}

/** Exchange a user's Jellyfin credentials for an access token. */
export function authenticateByName(
  url: string,
  deviceId: string,
  username: string,
  password: string
) {
  return jfFetch<JellyfinAuthResult>(url, "/Users/AuthenticateByName", deviceId, undefined, {
    method: "POST",
    body: JSON.stringify({ Username: username, Pw: password }),
  });
}

/** "Continue Watching": partially-played videos, newest first. */
export function getResumeItems(conn: JellyfinConnection) {
  const params = new URLSearchParams({
    Limit: "100",
    MediaTypes: "Video",
    Fields: "ProviderIds",
    EnableImages: "false",
  });
  return jfFetch<{ Items?: JellyfinItem[] }>(
    conn.url,
    `/Users/${conn.userId}/Items/Resume?${params}`,
    conn.deviceId,
    conn.accessToken
  );
}

/** "Next Up": the next unwatched episode of each in-progress series. */
export function getNextUp(conn: JellyfinConnection) {
  const params = new URLSearchParams({
    UserId: conn.userId,
    Limit: "100",
    Fields: "ProviderIds",
    EnableImages: "false",
  });
  return jfFetch<{ Items?: JellyfinItem[] }>(
    conn.url,
    `/Shows/NextUp?${params}`,
    conn.deviceId,
    conn.accessToken
  );
}

/** A single item with ProviderIds (used to resolve a series' TMDB/TVDB ids). */
export function getItem(conn: JellyfinConnection, itemId: string) {
  return jfFetch<JellyfinItem>(
    conn.url,
    `/Users/${conn.userId}/Items/${itemId}`,
    conn.deviceId,
    conn.accessToken
  );
}

/** Every episode of a series with the user's per-episode watch state. */
export function getSeriesEpisodes(conn: JellyfinConnection, seriesId: string) {
  const params = new URLSearchParams({
    UserId: conn.userId,
    Fields: "ProviderIds",
    EnableUserData: "true",
    EnableImages: "false",
  });
  return jfFetch<{ Items?: JellyfinItem[] }>(
    conn.url,
    `/Shows/${seriesId}/Episodes?${params}`,
    conn.deviceId,
    conn.accessToken
  );
}

/** Best-effort token revocation on unlink; failures are the caller's to swallow. */
export function logout(conn: JellyfinConnection) {
  return jfFetch<undefined>(conn.url, "/Sessions/Logout", conn.deviceId, conn.accessToken, {
    method: "POST",
  });
}
