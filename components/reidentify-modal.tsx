"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { LookupResult } from "@/lib/types";
import { Input, Modal, Skeleton, useToast } from "@/components/ui";

/**
 * A "pick the correct TMDB title" modal used to re-identify a movie/series/anime
 * that was matched to the wrong title. Debounced TMDB search over `/lookup`;
 * clicking a poster confirms via `onConfirm(tmdbId)`.
 */
export function ReidentifyModal({
  type,
  currentTitle,
  onClose,
  onConfirm,
}: {
  type: "movie" | "series" | "anime";
  currentTitle: string;
  onClose: () => void;
  /** Apply the chosen title. Throw to surface an error and keep the modal open. */
  onConfirm: (tmdbId: number) => Promise<void>;
}) {
  const [query, setQuery] = useState(currentTitle);
  const [results, setResults] = useState<LookupResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const toast = useToast();
  const busy = confirmingId !== null;

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let active = true;
    const timer = setTimeout(() => {
      setSearching(true);
      apiFetch<LookupResult[]>(`/lookup?type=${type}&q=${encodeURIComponent(q)}`)
        .then((res) => active && setResults(res))
        .catch(() => active && setResults([]))
        .finally(() => active && setSearching(false));
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, type]);

  async function pick(r: LookupResult) {
    setConfirmingId(r.tmdbId);
    try {
      await onConfirm(r.tmdbId); // closes the modal on success
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Re-identify failed");
      setConfirmingId(null);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      dismissable={!busy}
      size="lg"
      title="Re-identify title"
      description="Search for the correct title and pick it. Downloaded files are kept; metadata is refreshed to the new title."
    >
      <div className="space-y-4">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search TMDB by title…"
          autoFocus
        />
        {searching && !results ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[2/3] w-full rounded" />
            ))}
          </div>
        ) : results && results.length === 0 ? (
          <p className="text-sm text-zinc-500">No matches — try a different search.</p>
        ) : results ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
            {results.map((r) => (
              <button
                key={r.tmdbId}
                type="button"
                disabled={busy}
                onClick={() => pick(r)}
                className="group flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/40 p-1.5 text-left transition-colors hover:border-amber-500/60 disabled:opacity-50"
              >
                {r.poster ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.poster} alt="" className="aspect-[2/3] w-full rounded object-cover" />
                ) : (
                  <div className="flex aspect-[2/3] w-full items-center justify-center rounded bg-zinc-800 text-center text-[10px] text-zinc-600">
                    No poster
                  </div>
                )}
                <div className="mt-1 truncate text-xs font-medium text-zinc-100">{r.title}</div>
                <div className="text-[10px] text-zinc-500">
                  {confirmingId === r.tmdbId ? "Applying…" : (r.year ?? "—")}
                </div>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
