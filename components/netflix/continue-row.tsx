"use client";

import { useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/ui";
import { VideoPlayerModal } from "@/components/media-player";
import { ROW_CARD_CLASS, ScrollRow } from "./scroll-row";
// Type-only import: the service is a server module, erased from the client bundle.
import type { ContinueItem } from "@/server/playback/watch-progress-service";

/** Stable identity for a card (also the selection key in edit mode). */
function itemKey(item: ContinueItem): string {
  return `${item.kind}-${item.movieId ?? ""}-${item.episodeId ?? ""}`;
}

/**
 * A titled, horizontally-scrollable row of resume cards (Continue Watching /
 * Recently Watched), on the same {@link ScrollRow} as the Discover rows. Each
 * landscape card shows the item's backdrop, title, episode and time left, with a
 * progress bar; clicking it opens the player.
 *
 * With `onChanged` set the row gains an Edit mode: cards become multi-selectable
 * and the selection can be marked watched in bulk (dropping it off the row).
 *
 * `items` undefined (still loading) or empty → the row renders nothing.
 */
export function ContinueRow({
  title,
  items,
  onChanged,
}: {
  title: string;
  items: ContinueItem[] | undefined;
  /** Called after items were marked watched; owner revalidates the list. */
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Nothing to resume → skip the whole row.
  if (!items || items.length === 0) return null;

  function stopEditing() {
    setEditing(false);
    setSelected(new Set());
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function markWatched(targets: ContinueItem[]) {
    if (targets.length === 0) return;
    setSaving(true);
    try {
      await apiFetch("/watch-progress/watched", {
        method: "POST",
        body: JSON.stringify({
          watched: true,
          items: targets.map((t) =>
            t.kind === "movie" ? { movieId: t.movieId } : { episodeId: t.episodeId }
          ),
        }),
      });
      toast.success(`Marked ${targets.length} as watched`);
      stopEditing();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not mark as watched");
    } finally {
      setSaving(false);
    }
  }

  const allKeys = items.map(itemKey);
  const selectedItems = items.filter((i) => selected.has(itemKey(i)));

  const editControls = onChanged ? (
    editing ? (
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() =>
            setSelected(selected.size === allKeys.length ? new Set() : new Set(allKeys))
          }
          className="rounded-full border border-zinc-700 px-3 py-1 text-zinc-300 transition-colors hover:bg-zinc-800"
        >
          {selected.size === allKeys.length ? "Select none" : "Select all"}
        </button>
        <button
          type="button"
          disabled={selected.size === 0 || saving}
          onClick={() => void markWatched(selectedItems)}
          className="rounded-full border border-emerald-700/60 px-3 py-1 text-emerald-400 transition-colors hover:bg-emerald-950/50 disabled:cursor-default disabled:opacity-40"
        >
          {saving ? "Marking…" : `Mark watched (${selected.size})`}
        </button>
        <button
          type="button"
          onClick={stopEditing}
          className="rounded-full px-3 py-1 text-zinc-400 transition-colors hover:text-zinc-200"
        >
          Cancel
        </button>
      </div>
    ) : (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded-full px-3 py-1 text-xs text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
      >
        Edit
      </button>
    )
  ) : null;

  return (
    <ScrollRow title={title} actions={editControls}>
      {items.map((item) => (
        // Key by STABLE identity only — never include updatedAt. Each card owns
        // its own `playing` state; while playing, the player saves progress
        // (bumping updatedAt), and a window-focus refetch of this list would then
        // change the key, remount the card, and drop `playing` — closing the
        // player whenever you switch windows.
        <div key={itemKey(item)} className={ROW_CARD_CLASS}>
          <ContinueCard
            item={item}
            editing={editing}
            selected={selected.has(itemKey(item))}
            onToggle={() => toggle(itemKey(item))}
            onMarkWatched={onChanged ? () => void markWatched([item]) : undefined}
          />
        </div>
      ))}
    </ScrollRow>
  );
}

/** "1 h 12 min left" / "23 min left", or null when the runtime isn't known. */
function timeLeft(item: ContinueItem): string | null {
  if (item.durationSeconds <= 0 || item.positionSeconds <= 0) return null;
  const minutes = Math.max(1, Math.round((item.durationSeconds - item.positionSeconds) / 60));
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h} h ${minutes % 60} min left` : `${minutes} min left`;
}

/**
 * A single landscape resume card. The card plays (it's what Continue Watching is
 * for); a Details button on it opens the movie or series page instead, and the ✓
 * marks it watched. A red bar shows how far in it is. In edit mode the card
 * toggles selection instead of playing.
 */
function ContinueCard({
  item,
  editing,
  selected,
  onToggle,
  onMarkWatched,
}: {
  item: ContinueItem;
  editing: boolean;
  selected: boolean;
  onToggle: () => void;
  onMarkWatched?: () => void;
}) {
  const [playing, setPlaying] = useState(false);

  const image = item.backdrop ?? item.poster;
  // The player targets the movie for movies, or the episode for episodes.
  const targetId = item.movieId ?? item.episodeId;
  const detailHref =
    item.kind === "movie"
      ? item.movieId != null
        ? `/movies/${item.movieId}`
        : null
      : item.seriesId != null
        ? `/series/${item.seriesId}`
        : null;
  const left = timeLeft(item);
  const showBar = item.progressPct > 0;

  return (
    <div className="group relative w-full">
      <div
        className={cn(
          "relative aspect-video overflow-hidden rounded-xl bg-zinc-900 shadow-lg ring-1 ring-white/10 transition duration-300 ease-out group-hover:-translate-y-1 group-hover:shadow-2xl group-hover:shadow-black/60 group-hover:ring-white/30",
          editing && selected && "ring-2 ring-emerald-500 group-hover:ring-emerald-400"
        )}
      >
        <button
          type="button"
          onClick={() => (editing ? onToggle() : setPlaying(true))}
          disabled={!editing && targetId == null}
          aria-label={editing ? `Select ${item.title}` : `Play ${item.title}`}
          className="absolute inset-0 block h-full w-full text-left focus-visible:outline-none disabled:cursor-default"
        >
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900 px-4 text-center text-sm text-zinc-400">
              {item.title}
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />

          {editing ? (
            <span
              className={cn(
                "absolute top-2.5 left-2.5 flex size-7 items-center justify-center rounded-full border text-sm shadow-lg",
                selected
                  ? "border-emerald-400 bg-emerald-500 text-black"
                  : "border-white/70 bg-black/50 text-transparent"
              )}
            >
              ✓
            </span>
          ) : (
            // The play glyph: always there on touch screens, on hover elsewhere.
            <span className="absolute inset-0 flex items-center justify-center opacity-100 transition-opacity duration-200 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
              <span className="flex size-14 items-center justify-center rounded-full bg-white text-black shadow-xl shadow-black/50">
                <svg
                  viewBox="0 0 24 24"
                  className="ml-1 size-7"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M7 4.5v15a1 1 0 0 0 1.52.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5z" />
                </svg>
              </span>
            </span>
          )}

          <span className="absolute inset-x-0 bottom-0 block px-3 pt-8 pb-4 sm:px-4">
            <span className="block truncate text-base font-semibold text-white drop-shadow sm:text-lg">
              {item.title}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-300">
              {item.subtitle && <span className="truncate">{item.subtitle}</span>}
              {item.subtitle && left && <span className="text-zinc-500">·</span>}
              {left && <span className="shrink-0">{left}</span>}
              {!item.subtitle && !left && <span>Up next</span>}
            </span>
          </span>

          {/* Progress (skipped for a queued "next episode" at 0%). */}
          {showBar && (
            <span className="absolute inset-x-0 bottom-0 block h-1 bg-white/20">
              <span
                className="block h-full bg-red-600"
                style={{ width: `${Math.min(100, Math.max(0, item.progressPct))}%` }}
              />
            </span>
          )}
        </button>

        {!editing && (
          <div className="absolute top-2.5 right-2.5 z-10 flex items-center gap-1.5 opacity-100 transition-opacity duration-200 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
            {detailHref && (
              <Link
                href={detailHref}
                className="rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white ring-1 ring-white/20 backdrop-blur transition-colors hover:bg-black/85"
              >
                Details
              </Link>
            )}
            {onMarkWatched && (
              <button
                type="button"
                onClick={onMarkWatched}
                aria-label={`Mark ${item.title} watched`}
                title="Mark watched"
                className="flex size-7 items-center justify-center rounded-full bg-black/60 text-sm text-white ring-1 ring-white/20 backdrop-blur transition-colors hover:bg-emerald-600"
              >
                ✓
              </button>
            )}
          </div>
        )}
      </div>

      {playing && targetId != null && (
        <VideoPlayerModal
          target={{ type: item.kind === "movie" ? "movie" : "episode", id: targetId }}
          title={
            <span>
              {item.title}
              {item.subtitle ? <span className="text-zinc-400"> — {item.subtitle}</span> : null}
            </span>
          }
          onClose={() => setPlaying(false)}
        />
      )}
    </div>
  );
}
