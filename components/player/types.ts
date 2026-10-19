/** What the player plays: a movie or an episode, by id. */
export type PlaybackTarget = { type: "movie" | "episode"; id: number };

/**
 * Watch-together wiring for a player instance.
 *   host   → mirror this player's play/pause/seek/episode-change OUT to joiners.
 *   joiner → apply incoming sync commands (and skip saving own watch-progress).
 * `startPositionSeconds` (joiner) is the host's position at join time.
 */
export type WatchSync =
  | { role: "host"; hostUserId?: number }
  | { role: "joiner"; hostUserId?: number; startPositionSeconds?: number };

/** Direct play streams the file as-is; transcode is server-side HLS via ffmpeg. */
export type PlaybackMode = "direct" | "transcode";

/**
 * The previous / next PLAYABLE episode relative to the one now playing, as served
 * by `GET /api/v1/episodes/{id}/neighbors`. `null` when there is no such neighbor.
 */
export type Neighbor = {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  seriesTitle: string;
};

/** One provider hit from `GET /api/v1/subtitles/manual` (live online search). */
export type SubtitleCandidate = {
  id: string;
  providerName: string;
  language: string;
  release: string;
  hearingImpaired: boolean;
};

/** A skippable intro/recap stretch from `GET /api/v1/skip-segments`. */
export type SkipSegment = {
  type: "intro" | "recap";
  startSeconds: number;
  endSeconds: number;
  label: string;
};

/** An audio track from `GET /api/v1/audio-tracks` (for multi-audio files). */
export type AudioTrack = {
  index: number;
  codec: string;
  channels: number | null;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  label: string;
};

/** Shape of `GET /api/v1/watch-progress` (or `null` when nothing is stored). */
export type WatchProgress = { positionSeconds: number; durationSeconds: number; watched: boolean };

/**
 * A selectable file version (quality) for the current title, from
 * `GET /api/v1/versions`. Movies can have several (e.g. a 1080p + a 4K); episodes
 * return a single entry. `resolution` is a short tag ("4K"/"1080p"); `label` is
 * fuller (e.g. "4K · WEB-DL-2160p").
 */
export type MediaVersion = {
  fileId: number;
  resolution: string;
  label: string;
  size: number;
  isPrimary: boolean;
  durationSec: number | null;
};

/** Progress reported up from whichever child player is mounted. */
export type TimeReport = (currentTime: number, duration: number) => void;
