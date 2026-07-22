"use client";

import { useEffect, useImperativeHandle, useState, type Ref } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { LookupResult } from "@/lib/types";
import type { ImportCandidate } from "@/server/library/library-import";
import { Badge, Button, Input, Spinner, useToast } from "@/components/ui";

type ImportType = "movie" | "series" | "anime";

/** The currently-chosen TMDB title a row will import against. */
interface Target {
  tmdbId: number;
  title: string;
  year: number | null;
  poster: string | null;
}

/** Imperative handle so the page's "Import all" can drive each matched row. */
export interface CandidateRowHandle {
  /** Import the currently-selected target. No-op if already imported or nothing selected. */
  importSelected: () => Promise<void>;
}

interface CandidateRowProps {
  candidate: ImportCandidate;
  type: ImportType;
  rootFolderId: number;
  qualityProfileId: number;
  onImported: (path: string) => void;
  ref?: Ref<CandidateRowHandle>;
}

/** Pick the default target for a "matched" candidate from its suggestions. */
function initialTargetFor(candidate: ImportCandidate): Target | null {
  if (candidate.status !== "matched" || candidate.suggestedTmdbId == null) return null;
  const s = candidate.suggestions.find((x) => x.tmdbId === candidate.suggestedTmdbId);
  return s ? { tmdbId: s.tmdbId, title: s.title, year: s.year, poster: s.poster } : null;
}

export function CandidateRow({
  candidate,
  type,
  rootFolderId,
  qualityProfileId,
  onImported,
  ref,
}: CandidateRowProps) {
  const toast = useToast();
  const [target, setTarget] = useState<Target | null>(() => initialTargetFor(candidate));
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  // Matched rows hide the picker behind a "Change" toggle; unsure rows show it up front.
  const [showPicker, setShowPicker] = useState(candidate.status === "unsure");

  // A series/anime scan can surface a movie (anime films in an anime root);
  // search and import must then follow the candidate's actual kind, not the scan type.
  const isMovie = candidate.mediaKind === "movie";
  const lookupType: ImportType = isMovie ? "movie" : type;

  // Search box: prefilled with the parsed title, only queried once the admin edits it.
  const [search, setSearch] = useState(candidate.parsedTitle);
  const [touched, setTouched] = useState(false);
  const [results, setResults] = useState<LookupResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!touched) return;
    const q = search.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = setTimeout(async () => {
      try {
        const res = await apiFetch<LookupResult[]>(
          `/lookup?type=${lookupType}&q=${encodeURIComponent(q)}`
        );
        setResults(res);
      } catch {
        setResults(null);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(id);
  }, [search, touched, lookupType]);

  async function doImport() {
    if (!target || imported || importing) return;
    setImporting(true);
    try {
      const res = await apiFetch<{ id: number; mediaType: string; files: number }>(
        "/library-import",
        {
          method: "POST",
          body: JSON.stringify({
            type,
            mediaKind: candidate.mediaKind,
            path: candidate.path,
            // Register the exact file for movie imports (many can share a folder).
            videoPath: isMovie ? candidate.videoPath || undefined : undefined,
            tmdbId: target.tmdbId,
            rootFolderId,
            qualityProfileId,
            monitored: true,
          }),
        }
      );
      toast.success(`Imported (${res.files} files)`);
      setImported(true);
      onImported(candidate.path);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.info(err.message);
        setImported(true);
        onImported(candidate.path);
      } else {
        toast.error(err instanceof Error ? err.message : "Import failed");
      }
    } finally {
      setImporting(false);
    }
  }

  useImperativeHandle(ref, () => ({ importSelected: doImport }));

  const matched = candidate.status === "matched";

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="truncate font-mono text-xs text-zinc-400">{candidate.name}</div>
          <div className="text-sm font-medium text-zinc-100">
            {candidate.parsedTitle}
            {candidate.parsedYear ? (
              <span className="text-zinc-500"> ({candidate.parsedYear})</span>
            ) : null}
          </div>
          <div className="text-xs text-zinc-500">
            {candidate.videoFileCount} video file{candidate.videoFileCount === 1 ? "" : "s"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isMovie && type !== "movie" && <Badge tone="neutral">Movie</Badge>}
          {matched ? (
            <Badge tone="success">Match</Badge>
          ) : (
            <Badge tone="warning">Needs review</Badge>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-4">
        {target ? (
          <div className="flex min-w-0 items-center gap-2">
            {target.poster ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={target.poster}
                alt=""
                loading="lazy"
                className="h-14 w-[38px] shrink-0 rounded object-cover"
              />
            ) : (
              <div className="h-14 w-[38px] shrink-0 rounded bg-zinc-800" />
            )}
            <div className="min-w-0">
              <div className="truncate text-sm text-zinc-100">{target.title}</div>
              {target.year != null && (
                <div className="text-xs text-zinc-500">{target.year}</div>
              )}
            </div>
          </div>
        ) : (
          <span className="text-xs text-zinc-500">
            No title selected yet — pick the correct one below.
          </span>
        )}

        <div className="flex shrink-0 items-center gap-2">
          {imported ? (
            <span className="text-sm font-medium text-emerald-400">Imported ✓</span>
          ) : (
            <>
              {target && (
                <Button onClick={doImport} loading={importing}>
                  Import
                </Button>
              )}
              {matched && (
                <Button variant="ghost" onClick={() => setShowPicker((v) => !v)}>
                  {showPicker ? "Hide" : "Change"}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {showPicker && !imported && (
        <div className="mt-3 space-y-3 border-t border-zinc-800 pt-3">
          {candidate.suggestions.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-zinc-400">Suggestions</div>
              <PosterRow
                items={candidate.suggestions}
                selectedTmdbId={target?.tmdbId ?? null}
                onSelect={setTarget}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setTouched(true);
                }}
                placeholder={`Search TMDB for the correct ${type === "movie" ? "movie" : type === "anime" ? "anime" : "series"}…`}
                className="flex-1"
              />
              {searching && <Spinner className="size-4 text-zinc-500" />}
            </div>
            {results && results.length > 0 && (
              <PosterRow items={results} selectedTmdbId={target?.tmdbId ?? null} onSelect={setTarget} />
            )}
            {results && results.length === 0 && !searching && (
              <p className="text-xs text-zinc-500">No results for “{search.trim()}”.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Horizontal, scrollable strip of selectable poster cards. */
function PosterRow({
  items,
  selectedTmdbId,
  onSelect,
}: {
  items: { tmdbId: number; title: string; year: number | null; poster: string | null }[];
  selectedTmdbId: number | null;
  onSelect: (t: Target) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {items.map((it) => {
        const selected = it.tmdbId === selectedTmdbId;
        return (
          <button
            key={it.tmdbId}
            type="button"
            onClick={() =>
              onSelect({ tmdbId: it.tmdbId, title: it.title, year: it.year, poster: it.poster })
            }
            className={cn(
              "w-24 shrink-0 rounded border p-1.5 text-left transition-colors",
              selected
                ? "border-amber-500 bg-amber-500/10"
                : "border-zinc-800 bg-zinc-900/50 hover:border-amber-500/50"
            )}
          >
            {it.poster ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={it.poster}
                alt=""
                loading="lazy"
                className="aspect-[2/3] w-full rounded object-cover"
              />
            ) : (
              <div className="aspect-[2/3] w-full rounded bg-zinc-800" />
            )}
            <div className="mt-1 truncate text-xs text-zinc-200">{it.title}</div>
            {it.year != null && <div className="text-[10px] text-zinc-500">{it.year}</div>}
          </button>
        );
      })}
    </div>
  );
}
