"use client";

import { useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui";
import { VideoPlayerModal } from "@/components/media-player";
// Type-only import: the service is a server module, erased from the client bundle.
import type { ContinueItem } from "@/server/playback/watch-progress-service";

/** Stable identity for a card (also the selection key in edit mode). */
function itemKey(item: ContinueItem): string {
  return `${item.kind}-${item.movieId ?? ""}-${item.episodeId ?? ""}`;
}

/**
 * A titled, horizontally-scrollable row of resume cards (Continue Watching /
 * Recently Watched). Mirrors {@link NetflixRow}'s chrome — hidden scrollbar,
 * hover chevrons, vertical padding so the cards' hover-scale isn't clipped —
 * but each landscape card shows the item's backdrop, title, an optional episode
 * subtitle, and a progress bar, and clicking it opens the player.
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
  const trackRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  function page(dir: -1 | 1) {
    const el = trackRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: "smooth" });
  }

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

  return (
    <section className="group/row relative">
      <div className="flex items-center gap-3 px-4 md:px-12">
        <h2 className="text-lg font-semibold text-zinc-200">{title}</h2>
        {onChanged &&
          (editing ? (
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() =>
                  setSelected(selected.size === allKeys.length ? new Set() : new Set(allKeys))
                }
                className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                {selected.size === allKeys.length ? "Select none" : "Select all"}
              </button>
              <button
                type="button"
                disabled={selected.size === 0 || saving}
                onClick={() => void markWatched(selectedItems)}
                className="rounded-md border border-emerald-700/60 px-2 py-1 text-emerald-400 transition-colors hover:bg-emerald-950/50 disabled:cursor-default disabled:opacity-40"
              >
                {saving ? "Marking…" : `Mark watched (${selected.size})`}
              </button>
              <button
                type="button"
                onClick={stopEditing}
                className="rounded-md px-2 py-1 text-zinc-400 transition-colors hover:text-zinc-200"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-md px-2 py-1 text-xs text-zinc-500 opacity-0 transition-opacity hover:text-zinc-200 focus-visible:opacity-100 group-hover/row:opacity-100"
            >
              Edit
            </button>
          ))}
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => page(-1)}
          aria-label="Scroll left"
          className="absolute left-0 top-0 z-20 hidden h-full w-10 items-center justify-center bg-gradient-to-r from-black/70 to-transparent text-2xl text-white opacity-0 transition-opacity hover:from-black/90 group-hover/row:opacity-100 md:flex"
        >
          ‹
        </button>

        <div
          ref={trackRef}
          className="no-scrollbar flex gap-2 overflow-x-auto scroll-smooth px-4 py-8 md:px-12"
        >
          {items.map((item) => (
            // Key by STABLE identity only — never include updatedAt. Each card
            // owns its own `playing` state; while playing, the player saves
            // progress (bumping updatedAt), and a window-focus refetch of this
            // list would then change the key, remount the card, and drop
            // `playing` — closing the player whenever you switch windows.
            <div key={itemKey(item)} className="w-[240px] shrink-0">
              <ContinueCard
                item={item}
                editing={editing}
                selected={selected.has(itemKey(item))}
                onToggle={() => toggle(itemKey(item))}
                onMarkWatched={onChanged ? () => void markWatched([item]) : undefined}
              />
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => page(1)}
          aria-label="Scroll right"
          className="absolute right-0 top-0 z-20 hidden h-full w-10 items-center justify-center bg-gradient-to-l from-black/70 to-transparent text-2xl text-white opacity-0 transition-opacity hover:from-black/90 group-hover/row:opacity-100 md:flex"
        >
          ›
        </button>
      </div>
    </section>
  );
}

/**
 * A single landscape resume card. On hover it scales up (matching TitleCard),
 * dims with a centred play glyph, and — when the item has playback progress —
 * shows a red progress bar pinned to the bottom edge. Clicking opens the player
 * for the underlying movie or episode; the modal state is kept local to the card.
 * In edit mode the card toggles selection instead of playing.
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
  const showBar = item.progressPct > 0;

  return (
    <div className="group relative aspect-video w-full">
      {/* Scaling layer — transform keeps the row layout from reflowing. */}
      <div className="absolute inset-0 origin-center rounded-md transition-transform duration-300 ease-out group-hover:z-30 group-hover:scale-[1.3] group-focus-within:z-30 group-focus-within:scale-[1.3]">
        <button
          type="button"
          onClick={() => (editing ? onToggle() : setPlaying(true))}
          disabled={!editing && targetId == null}
          aria-label={editing ? `Select ${item.title}` : `Play ${item.title}`}
          className={`relative block h-full w-full overflow-hidden rounded-md bg-zinc-900 text-left shadow-lg transition-shadow group-hover:shadow-2xl disabled:cursor-default ${
            editing && selected ? "ring-2 ring-emerald-500" : ""
          }`}
        >
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <div className="flex h-full w-full items-center justify-center px-2 text-center text-xs text-zinc-500">
              {item.title}
            </div>
          )}

          {/* Hover affordance: play glyph normally, checkbox in edit mode. */}
          {editing ? (
            <div className="absolute inset-0 bg-black/30">
              <span
                className={`absolute left-2 top-2 flex size-6 items-center justify-center rounded-full border text-sm shadow-lg ${
                  selected
                    ? "border-emerald-400 bg-emerald-500 text-black"
                    : "border-white/70 bg-black/50 text-transparent"
                }`}
              >
                ✓
              </span>
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-300 group-hover:bg-black/30 group-hover:opacity-100 group-focus-within:bg-black/30 group-focus-within:opacity-100">
              <span className="flex size-10 items-center justify-center rounded-full bg-white/90 text-lg text-black shadow-lg">
                ▶
              </span>
            </div>
          )}

          {/* Name + optional episode subtitle band */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 pb-3 pt-8">
            <div className="truncate text-sm font-medium text-white drop-shadow">{item.title}</div>
            {item.subtitle && (
              <div className="truncate text-[10px] uppercase tracking-wide text-zinc-300">
                {item.subtitle}
              </div>
            )}
          </div>

          {/* Progress bar (skipped for queued "next episode" at 0%) */}
          {showBar && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
              <div
                className="h-full bg-red-600"
                style={{ width: `${Math.min(100, Math.max(0, item.progressPct))}%` }}
              />
            </div>
          )}
        </button>

        {/* Quick "mark watched" on hover (outside edit mode). */}
        {!editing && onMarkWatched && (
          <button
            type="button"
            onClick={onMarkWatched}
            aria-label={`Mark ${item.title} watched`}
            title="Mark watched"
            className="absolute right-1.5 top-1.5 z-10 flex size-7 items-center justify-center rounded-full bg-black/60 text-sm text-white opacity-0 shadow-lg transition-opacity hover:bg-emerald-600 focus-visible:opacity-100 group-hover:opacity-100"
          >
            ✓
          </button>
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
