"use client";

import { useCallback, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { SubtitleTrack } from "@/components/subtitle-overlay";
import { formatOffset } from "./format";
import { SearchIcon } from "./icons";
import { MenuItem, MenuPanel } from "./menu";
import type { PlaybackTarget, SubtitleCandidate } from "./types";

/** Subtitle-sync nudge, in seconds, per button press / keypress. */
export const SUBTITLE_OFFSET_STEP = 0.1;

/**
 * Live provider search from the CC menu (admin-gated server-side): find
 * candidates, download one, and hand back its index in the refreshed track list.
 * Lives above the menu so results survive it closing and reopening.
 */
export function useSubtitleSearch(
  target: PlaybackTarget,
  languages: string[],
  reloadTracks: () => Promise<SubtitleTrack[]>,
  onAdded: (tracks: SubtitleTrack[], index: number) => void
) {
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<SubtitleCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const key = target.type === "movie" ? "movieId" : "episodeId";

  const search = useCallback(async () => {
    const langs = languages.length > 0 ? languages : ["en"];
    setSearching(true);
    setError(null);
    setCandidates(null);
    try {
      const res = await apiFetch<SubtitleCandidate[]>(
        `/subtitles/manual?${key}=${target.id}&languages=${encodeURIComponent(langs.join(","))}`
      );
      setCandidates(res);
      if (res.length === 0) setError("No subtitles found from your providers.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Search failed. Try again.");
    } finally {
      setSearching(false);
    }
  }, [key, target.id, languages]);

  const download = useCallback(
    async (candidate: SubtitleCandidate) => {
      setDownloadingId(candidate.id);
      setError(null);
      try {
        await apiFetch(`/subtitles/manual`, {
          method: "POST",
          body: JSON.stringify({ [key]: target.id, candidateId: candidate.id }),
        });
        const tracks = await reloadTracks();
        // Prefer the freshly-downloaded language among external tracks.
        const idx = tracks.findIndex(
          (t) => t.kind !== "embedded" && t.language === candidate.language
        );
        setCandidates(null);
        onAdded(tracks, idx >= 0 ? idx : tracks.length > 0 ? 0 : -1);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Download failed. Try another.");
      } finally {
        setDownloadingId(null);
      }
    },
    [key, target.id, reloadTracks, onAdded]
  );

  return { searching, candidates, error, downloadingId, search, download };
}

export type SubtitleSearch = ReturnType<typeof useSubtitleSearch>;

/** The CC menu: track choice, online search (admins), and sync timing. */
export function SubtitleMenu({
  tracks,
  selected,
  onSelect,
  canSearch,
  search,
  offset,
  onNudge,
  onResetOffset,
}: {
  tracks: SubtitleTrack[];
  selected: number;
  onSelect: (index: number) => void;
  canSearch: boolean;
  search: SubtitleSearch;
  offset: number;
  onNudge: (delta: number) => void;
  onResetOffset: () => void;
}) {
  return (
    <MenuPanel className="min-w-56">
      <MenuItem label="Off" active={selected === -1} onSelect={() => onSelect(-1)} />
      {tracks.length === 0 && (
        <p className="px-3 py-2 text-xs text-zinc-500">No subtitles available</p>
      )}
      {tracks.map((t, i) => (
        <MenuItem key={t.id} label={t.label} active={selected === i} onSelect={() => onSelect(i)} />
      ))}

      {canSearch && (
        <div className="mt-1 border-t border-white/10 px-2 pt-2 pb-1">
          <button
            type="button"
            onClick={() => void search.search()}
            disabled={search.searching}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs font-medium text-zinc-100 transition-colors hover:bg-white/10 disabled:opacity-60"
          >
            <SearchIcon className={cn("size-4 shrink-0", search.searching && "animate-pulse")} />
            {search.searching ? "Searching providers…" : "Search online for subtitles"}
          </button>
          {search.error && (
            <p className="px-2 py-1 text-[11px] text-amber-400/90">{search.error}</p>
          )}
          {search.candidates && search.candidates.length > 0 && (
            <ul className="mt-1 max-h-40 overflow-auto">
              {search.candidates.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => void search.download(c)}
                    disabled={search.downloadingId !== null}
                    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-white/10 disabled:opacity-60"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[11px] text-zinc-100">
                        {c.release || c.providerName}
                      </span>
                      <span className="block truncate text-[10px] text-zinc-500">
                        {c.language.toUpperCase()} · {c.providerName}
                        {c.hearingImpaired ? " · SDH" : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] font-medium text-amber-300">
                      {search.downloadingId === c.id ? "…" : "Add"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {selected >= 0 && (
        <div className="mt-1 border-t border-white/10 px-3 pt-2 pb-1">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
              Timing
            </span>
            {offset !== 0 && (
              <button
                type="button"
                onClick={onResetOffset}
                className="text-[11px] text-zinc-400 hover:text-zinc-200"
              >
                Reset
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <OffsetButton label="Subtitles earlier" onClick={() => onNudge(-SUBTITLE_OFFSET_STEP)}>
              −
            </OffsetButton>
            <span className="min-w-14 text-center text-xs font-medium text-zinc-100 tabular-nums">
              {formatOffset(offset)}
            </span>
            <OffsetButton label="Subtitles later" onClick={() => onNudge(SUBTITLE_OFFSET_STEP)}>
              +
            </OffsetButton>
          </div>
          <div className="mt-1.5 text-center text-[10px] text-zinc-500">
            Shortcut: <kbd className="text-zinc-400">[</kbd> earlier ·{" "}
            <kbd className="text-zinc-400">]</kbd> later
          </div>
        </div>
      )}
    </MenuPanel>
  );
}

function OffsetButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex size-7 items-center justify-center rounded border border-white/15 text-base leading-none text-zinc-100 transition-colors hover:bg-white/10"
    >
      {children}
    </button>
  );
}
