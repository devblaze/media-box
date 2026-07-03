"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import { Badge, Button, EmptyState, Select, Spinner, useToast } from "@/components/ui";

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
  const { data: settings } = useApi<Settings>("/settings");

  const languages = useMemo(() => {
    const list = (settings?.subtitleLanguages ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length ? list : ["en"];
  }, [settings]);

  // Default to the first wanted language once settings resolve.
  const [language, setLanguage] = useState<string | null>(null);
  useEffect(() => {
    if (language === null && languages.length) setLanguage(languages[0]);
  }, [languages, language]);

  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());

  // (Re)search whenever the chosen language changes.
  useEffect(() => {
    if (!language) return;
    let cancelled = false;
    setCandidates(null);
    setError(null);
    setDone(new Set());
    apiFetch<Candidate[]>(`/subtitles/manual?${targetQuery(target)}&language=${language}`)
      .then((r) => !cancelled && setCandidates(r))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Search failed"));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

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

        <div className="mt-3 flex items-center gap-2">
          <label htmlFor="subtitle-language" className="text-sm text-zinc-400">
            Language
          </label>
          <div className="w-44">
            <Select
              id="subtitle-language"
              value={language ?? ""}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {languages.map((code) => (
                <option key={code} value={code}>
                  {langLabel(code)}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        {!candidates && !error && (
          <div className="mt-8 flex items-center justify-center gap-2 text-sm text-zinc-400">
            <Spinner /> Searching providers…
          </div>
        )}

        {candidates && candidates.length === 0 && !error && (
          <EmptyState
            className="mt-4"
            title="No subtitles found"
            description="Try another language or provider — you can enable more under Settings → Subtitles."
          />
        )}

        {candidates && candidates.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="py-1.5 pr-3 font-normal">Provider</th>
                  <th className="py-1.5 pr-3 font-normal">Release</th>
                  <th className="py-1.5 pr-3 font-normal" />
                  <th className="py-1.5 font-normal" />
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.id} className="border-t border-zinc-800/60">
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
        )}
      </div>
    </div>
  );
}
