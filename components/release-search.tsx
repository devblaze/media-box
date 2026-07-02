"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { formatBytes } from "@/lib/types";

export type SearchScope =
  | { episodeId: number }
  | { movieId: number }
  | { seriesId: number; season: number };

interface Release {
  guid: string;
  indexerName: string;
  title: string;
  size: number;
  seeders: number | null;
  accepted: boolean;
  rejections: string[];
  score: number;
  parsed: { quality: { qualityId: number } };
}

function scopeQuery(scope: SearchScope): string {
  if ("episodeId" in scope) return `episodeId=${scope.episodeId}`;
  if ("movieId" in scope) return `movieId=${scope.movieId}`;
  return `seriesId=${scope.seriesId}&season=${scope.season}`;
}

export function ReleaseSearchDrawer({
  scope,
  title,
  qualityNames,
  onClose,
}: {
  scope: SearchScope;
  title: string;
  qualityNames: Map<number, string>;
  onClose: () => void;
}) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grabbing, setGrabbing] = useState<string | null>(null);
  const [grabbed, setGrabbed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    apiFetch<Release[]>(`/release?${scopeQuery(scope)}`)
      .then((r) => !cancelled && setReleases(r))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Search failed"));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function grab(release: Release) {
    setGrabbing(release.guid);
    setError(null);
    try {
      await apiFetch("/release", {
        method: "POST",
        body: JSON.stringify({ guid: release.guid, ...scope }),
      });
      setGrabbed((prev) => new Set(prev).add(release.guid));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Grab failed");
    } finally {
      setGrabbing(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70" onClick={onClose}>
      <div
        className="max-h-[80vh] w-full max-w-5xl overflow-y-auto rounded-t-lg border border-zinc-700 bg-zinc-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Search — {title}</h2>
          <button onClick={onClose} className="rounded bg-zinc-800 px-3 py-1 text-sm hover:bg-zinc-700">
            Close
          </button>
        </div>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        {!releases && !error && <p className="mt-4 text-sm text-zinc-400">Searching indexers…</p>}

        {releases && (
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500">
                <th className="py-1.5 font-normal">Release</th>
                <th className="py-1.5 font-normal">Indexer</th>
                <th className="py-1.5 font-normal">Quality</th>
                <th className="py-1.5 font-normal">Size</th>
                <th className="py-1.5 font-normal">Seeders</th>
                <th className="py-1.5 font-normal" />
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <tr
                  key={r.guid}
                  className={`border-t border-zinc-800/60 ${r.accepted ? "" : "opacity-50"}`}
                  title={r.rejections.join("; ")}
                >
                  <td className="max-w-md truncate py-1.5 pr-3 font-mono text-xs">{r.title}</td>
                  <td className="py-1.5 pr-3 text-zinc-400">{r.indexerName}</td>
                  <td className="py-1.5 pr-3">
                    {qualityNames.get(r.parsed.quality.qualityId) ?? "Unknown"}
                  </td>
                  <td className="py-1.5 pr-3 text-zinc-400">{formatBytes(r.size)}</td>
                  <td className="py-1.5 pr-3 text-zinc-400">{r.seeders ?? "—"}</td>
                  <td className="py-1.5 text-right">
                    {grabbed.has(r.guid) ? (
                      <span className="text-xs text-green-400">Grabbed</span>
                    ) : (
                      <button
                        onClick={() => grab(r)}
                        disabled={grabbing !== null}
                        className="rounded bg-amber-500 px-2 py-0.5 text-xs font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
                      >
                        {grabbing === r.guid ? "…" : "Grab"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {releases.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-3 text-zinc-500">
                    No releases found. Check your indexers under Settings → Indexers.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {releases && releases.some((r) => !r.accepted) && (
          <p className="mt-2 text-xs text-zinc-500">
            Greyed-out rows are rejected — hover a row to see why. You can still grab them manually.
          </p>
        )}
      </div>
    </div>
  );
}
