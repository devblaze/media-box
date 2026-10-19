"use client";

import { useApi } from "@/lib/api";
import type { SubtitleTrack } from "@/components/subtitle-overlay";
import type { AudioTrack, MediaVersion, Neighbor, PlaybackTarget, SkipSegment } from "./types";

/** The full `GET /api/v1/subtitles` payload: tracks + live-search context. */
export type SubtitlesResponse = {
  tracks: SubtitleTrack[];
  languages?: string[];
  canSearchOnline?: boolean;
};

// Title metadata doesn't change under a viewer's feet; re-asking on every tab
// focus would only reshuffle the menus mid-film.
const STATIC = { revalidateOnFocus: false, revalidateOnReconnect: false } as const;
// Stable empties: a fresh [] per render would re-run every effect keyed on them.
const NONE: never[] = [];

/**
 * Everything the player looks up about the title it's playing. Each lookup fails
 * soft — an endpoint that errors leaves its feature empty (no picker, no skip
 * button), never the playback itself.
 */
export function useTitleData(target: PlaybackTarget) {
  const key = target.type === "movie" ? "movieId" : "episodeId";
  const q = `${key}=${target.id}`;

  const subtitles = useApi<SubtitlesResponse>(`/subtitles?${q}`, STATIC);
  const versions = useApi<{ versions: MediaVersion[] }>(
    `/versions?type=${target.type}&id=${target.id}`,
    STATIC
  );
  const neighbors = useApi<{ prev: Neighbor | null; next: Neighbor | null }>(
    target.type === "episode" ? `/episodes/${target.id}/neighbors` : null,
    STATIC
  );
  const skipSegments = useApi<SkipSegment[]>(`/skip-segments?${q}`, STATIC);
  const audioTracks = useApi<AudioTrack[]>(`/audio-tracks?${q}`, STATIC);

  return {
    tracks: subtitles.data?.tracks ?? NONE,
    subtitleLanguages: subtitles.data?.languages ?? NONE,
    canSearchSubtitles: !!subtitles.data?.canSearchOnline,
    /** Re-fetch the subtitle list (after a download) and return the new tracks. */
    reloadSubtitles: async () => (await subtitles.mutate())?.tracks ?? NONE,
    versions: versions.data?.versions ?? NONE,
    prevEpisode: neighbors.data?.prev ?? null,
    nextEpisode: neighbors.data?.next ?? null,
    skipSegments: Array.isArray(skipSegments.data) ? skipSegments.data : NONE,
    audioTracks: Array.isArray(audioTracks.data) ? audioTracks.data : NONE,
  };
}
