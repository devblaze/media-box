"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Badge, Button, EmptyState, Spinner, useToast } from "@/components/ui";

export type SubtitleTarget = { movieId: number } | { episodeId: number };

interface Candidate {
  id: string;
  providerId: string;
  providerName: string;
  language: string;
  release: string;
  hearingImpaired: boolean;
  score: number;
}

interface Settings {
  subtitleLanguages: string;
}

/** Friendly labels for the common ISO-639-1 codes; falls back to the raw code. */
const LANG_LABELS: Record<string, string> = {
  en: "English",
  el: "Greek",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
};

function langLabel(code: string): string {
  return LANG_LABELS[code] ?? code.toUpperCase();
}

function targetQuery(target: SubtitleTarget): string {
  return "movieId" in target ? `movieId=${target.movieId}` : `episodeId=${target.episodeId}`;
}

export function SubtitleSearchDrawer({
  target,
  title,
  onClose,
}: {
  target: SubtitleTarget;
  title: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const { data: settings, error: settingsError } = useApi<Settings>("/settings");
  const settingsReady = settings !== undefined || settingsError !== undefined;

  const languages = useMemo(() => {
    const list = (settings?.subtitleLanguages ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length ? list : ["en"];
  }, [settings]);

  // `null` = untouched (default to all wanted languages); a Set = an explicit
  // user choice, which may legitimately be empty (all deselected).
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const active = useMemo<Set<string>>(() => {
    if (selected) return selected;
    return settingsReady ? new Set(languages) : new Set();
  }, [selected, settingsReady, languages]);

  // Stable, order-independent key of the selected languages for the fetch effect.
  const languagesParam = useMemo(() => [...active].sort().join(","), [active]);
  const allSelected = languages.length > 0 && languages.every((c) => active.has(c));

  function toggle(code: string) {
    setSelected((prev) => {
      const next = new Set(prev ?? languages);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);

  // (Re)search whenever the set of selected languages changes; debounced so
  // rapid chip toggling collapses into a single request. Skipped when none
  // are selected (nothing to search for).
  useEffect(() => {
    if (!languagesParam) {
      setCandidates(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setCandidates(null);
    setError(null);
    setDone(new Set());
    const handle = setTimeout(() => {
      apiFetch<Candidate[]>(`/subtitles/manual?${targetQuery(target)}&languages=${languagesParam}`)
        .then((r) => {
          if (cancelled) return;
          setCandidates(r);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : "Search failed");
          setLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [languagesParam]);

  async function download(c: Candidate) {
    setDownloading(c.id);
    try {
      await apiFetch("/subtitles/manual", {
        method: "POST",
        body: JSON.stringify({ ...target, candidateId: c.id }),
      });
      setDone((prev) => new Set(prev).add(c.id));
      toast.success("Subtitle downloaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloading(null);
    }
  }

  async function scanDisk() {
    setScanning(true);
    try {
      await apiFetch("/subtitles/sync-disk", {
        method: "POST",
        body: JSON.stringify(target),
      });
      toast.success("Scanned disk for subtitles");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Disk scan failed");
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-t-lg border border-zinc-700 bg-zinc-900 p-4 sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="min-w-0 truncate text-lg font-semibold">Subtitles — {title}</h2>
          <button
            onClick={onClose}
            className="shrink-0 rounded bg-zinc-800 px-3 py-1 text-sm hover:bg-zinc-700"
          >
            Close
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm text-zinc-400">Languages</span>
              <button
                type="button"
                onClick={() => setSelected(new Set(languages))}
                disabled={allSelected}
                className="text-xs text-amber-400 hover:text-amber-300 disabled:cursor-not-allowed disabled:text-zinc-600"
              >
                Select all
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {languages.map((code) => {
                const on = active.has(code);
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => toggle(code)}
                    aria-pressed={on}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40",
                      on
                        ? "border-amber-500/40 bg-amber-500/15 text-amber-200"
                        : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                    )}
                  >
                    {langLabel(code)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1">
            <Button variant="secondary" size="sm" onClick={scanDisk} loading={scanning}>
              Scan disk for existing subtitles
            </Button>
            <p className="max-w-[15rem] text-right text-xs text-zinc-500">
              Found files are added as playable tracks.
            </p>
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        {!settingsReady || loading ? (
          <div className="mt-8 flex items-center justify-center gap-2 text-sm text-zinc-400">
            <Spinner /> Searching providers…
          </div>
        ) : !languagesParam ? (
          <EmptyState
            className="mt-4"
            title="No languages selected"
            description="Pick at least one language above to search subtitle providers."
          />
        ) : candidates && candidates.length === 0 && !error ? (
          <EmptyState
            className="mt-4"
            title="No subtitles found"
            description="Try another language or provider — you can enable more under Settings → Subtitles."
          />
        ) : candidates && candidates.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="py-1.5 pr-3 font-normal">Language</th>
                  <th className="py-1.5 pr-3 font-normal">Provider</th>
                  <th className="py-1.5 pr-3 font-normal">Release</th>
                  <th className="py-1.5 pr-3 font-normal" />
                  <th className="py-1.5 font-normal" />
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.id} className="border-t border-zinc-800/60">
                    <td className="py-1.5 pr-3">
                      <Badge tone="accent">{langLabel(c.language)}</Badge>
                    </td>
                    <td className="py-1.5 pr-3 text-zinc-300">{c.providerName}</td>
                    <td
                      className="max-w-md truncate py-1.5 pr-3 font-mono text-xs"
                      title={c.release}
                    >
                      {c.release}
                    </td>
                    <td className="py-1.5 pr-3">
                      {c.hearingImpaired && <Badge tone="info">HI</Badge>}
                    </td>
                    <td className="py-1.5 text-right">
                      {done.has(c.id) ? (
                        <span className="text-xs text-green-400">Downloaded</span>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => download(c)}
                          loading={downloading === c.id}
                          disabled={downloading !== null}
                        >
                          Download
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
