/**
 * media-box REST client for the mobile app. Every call targets the server the
 * user pointed the app at (its container URL); the base is set once the stored
 * URL loads and updated when they change servers. Auth is media-box's session
 * cookie, set by POST /auth/login and persisted by the platform cookie store —
 * so `credentials: "include"` carries it on subsequent requests.
 */

let baseUrl = "";

/** Normalize + remember the server base (no trailing slash). */
export function setBaseUrl(url: string): void {
  baseUrl = url.replace(/\/+$/, "");
}

export function getBaseUrl(): string {
  return baseUrl;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ReqOptions extends RequestInit {
  /** Override the base (used by the onboarding health check before it's saved). */
  base?: string;
}

async function request<T>(path: string, opts: ReqOptions = {}): Promise<T> {
  const base = (opts.base ?? baseUrl).replace(/\/+$/, "");
  if (!base) throw new ApiError(0, "No server configured");

  let res: Response;
  try {
    res = await fetch(`${base}/api/v1${path}`, {
      ...opts,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(opts.headers ?? {}),
      },
    });
  } catch {
    // Network-level failure (server down, wrong address, TLS, offline).
    throw new ApiError(0, "Could not reach the server. Check the address and that it's running.");
  }

  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    if (data && typeof data === "object" && "error" in data) {
      message = String((data as { error: unknown }).error);
    }
    throw new ApiError(res.status, message);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---- Types (subset of the server shapes the app uses) ----

export interface Health {
  status: string;
  version: string;
}

export interface SessionUser {
  id: number;
  username: string;
  role: string;
}

export interface DiscoverItem {
  tmdbId: number;
  mediaType: "movie" | "series";
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  isAnime: boolean;
  status: string;
  mediaId: number | null;
}

export interface SeriesResumeEp {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
}

export interface SeriesResume {
  hasStarted: boolean;
  action: "resume" | "start" | "start-from-available" | "unavailable";
  episode: SeriesResumeEp | null;
  resumeSeconds: number;
  firstAvailable: SeriesResumeEp | null;
  missingBefore: { seasonNumber: number; episodeNumber: number }[];
}

export interface WatchProgress {
  positionSeconds: number;
  durationSeconds: number;
  watched: boolean;
}

export interface TranscodeSession {
  sessionId: string;
  url: string;
}

export type PlayableType = "movie" | "episode";

// ---- Endpoints ----

/** Unauthenticated health probe — used by onboarding to validate an address. */
export const checkHealth = (base: string) =>
  request<Health>("/health", { method: "GET", base });

export const login = (username: string, password: string) =>
  request<SessionUser>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });

export const logout = () => request<unknown>("/auth/logout", { method: "POST" });

export const discover = (category: string) =>
  request<DiscoverItem[]>(`/discover?category=${encodeURIComponent(category)}`, {
    method: "GET",
  });

/** Fresh profile for the signed-in user (drawer header). */
export const me = () => request<SessionUser>("/auth/me", { method: "GET" });

/**
 * The shared cast token. Native video players don't reliably send the fetch
 * cookie store, so streams are fetched with the server's tokenized `?key=`
 * URLs — the same mechanism Chromecast/AirPlay receivers use.
 */
export const getCastToken = () => request<{ token: string }>("/cast", { method: "GET" });

/** What the Play button should do for a series: continue, start, or nothing. */
export const getSeriesResume = (seriesId: number) =>
  request<SeriesResume>(`/series/${seriesId}/resume`, { method: "GET" });

export const getWatchProgress = (type: PlayableType, id: number) =>
  request<WatchProgress | null>(
    `/watch-progress?${type === "movie" ? "movieId" : "episodeId"}=${id}`,
    { method: "GET" }
  );

export const saveWatchProgress = (
  type: PlayableType,
  id: number,
  positionSeconds: number,
  durationSeconds: number
) =>
  request<{ saved: boolean }>("/watch-progress", {
    method: "PUT",
    body: JSON.stringify({
      [type === "movie" ? "movieId" : "episodeId"]: id,
      positionSeconds,
      durationSeconds,
    }),
  });

/** Start an HLS transcode session (fallback when a file can't direct-play). */
export const startTranscode = (type: PlayableType, id: number, startSec = 0) =>
  request<TranscodeSession>("/transcode", {
    method: "POST",
    body: JSON.stringify({ type, id, startSec }),
  });

export const stopTranscode = (sessionId: string) =>
  request<unknown>(`/transcode/${encodeURIComponent(sessionId)}`, { method: "DELETE" });

/** Tokenized direct-play URL for the native player. */
export const streamUrl = (type: PlayableType, id: number, castToken: string) =>
  `${baseUrl}/api/v1/stream/${type}/${id}?key=${encodeURIComponent(castToken)}`;

/** Tokenized playlist URL for a transcode session (`url` from POST /transcode). */
export const transcodePlaylistUrl = (playlistPath: string, castToken: string) =>
  `${baseUrl}${playlistPath}?key=${encodeURIComponent(castToken)}`;
