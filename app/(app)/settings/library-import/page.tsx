"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiFetch, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import type { CommandRow, QualityProfile, RootFolder } from "@/lib/types";
import type { ImportCandidate, ImportSuggestion } from "@/server/library/library-import";
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  Select,
  Spinner,
  useConfirm,
  useToast,
} from "@/components/ui";
import { CandidateRow } from "@/components/library-import-row";

type ImportType = "movie" | "series" | "anime";

/** A recent command carrying its payload (the batch stores { type }). */
interface BatchCommand extends CommandRow {
  payload?: { type?: string } | null;
}

/** Media type of the root folders a given import type reads from. */
function rootMediaType(type: ImportType): RootFolder["mediaType"] {
  return type === "movie" ? "movies" : type === "anime" ? "anime" : "series";
}

interface ScanResponse {
  root: string;
  candidates: ImportCandidate[];
  truncated?: boolean;
}

/** The TMDB title a matched candidate will import against. */
function matchedSuggestion(c: ImportCandidate): ImportSuggestion | null {
  return c.suggestions.find((s) => s.tmdbId === c.suggestedTmdbId) ?? null;
}

export default function LibraryImportPage() {
  const [type, setType] = useState<ImportType>("movie");
  // `null` means "fall back to the first available option"; lets the type toggle reset the folder.
  const [rootFolderId, setRootFolderId] = useState<number | null>(null);
  const [qualityProfileId, setQualityProfileId] = useState<number | null>(null);

  const [scanning, setScanning] = useState(false);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [resetting, setResetting] = useState(false);

  const { data: rootFolders } = useApi<RootFolder[]>("/rootfolders");
  const { data: profiles } = useApi<QualityProfile[]>("/qualityprofiles");
  const { data: commands, mutate: mutateCommands } = useApi<BatchCommand[]>("/command");
  const toast = useToast();
  const confirm = useConfirm();
  // Establish the SSE subscription so command.updated events revalidate "/command".
  useEvents();

  const mediaType = rootMediaType(type);
  const folders = useMemo(
    () => (rootFolders ?? []).filter((f) => f.mediaType === mediaType),
    [rootFolders, mediaType]
  );

  const effectiveRootFolderId = rootFolderId ?? folders[0]?.id ?? null;
  const effectiveProfileId = qualityProfileId ?? profiles?.[0]?.id ?? null;

  // Reload a persisted scan whenever the type changes (and on first mount), so
  // leaving and returning keeps the unmatched list without rescanning.
  const refreshCandidates = useCallback(async (): Promise<ImportCandidate[]> => {
    const res = await apiFetch<{ candidates: ImportCandidate[] }>(
      `/library-import/candidates?type=${type}`
    );
    setCandidates(res.candidates);
    return res.candidates;
  }, [type]);

  useEffect(() => {
    let cancelled = false;
    setLoadingCandidates(true);
    setTruncated(false);
    setScanError(null);
    apiFetch<{ candidates: ImportCandidate[] }>(`/library-import/candidates?type=${type}`)
      .then((res) => {
        if (!cancelled) setCandidates(res.candidates);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingCandidates(false);
      });
    return () => {
      cancelled = true;
    };
  }, [type]);

  const matched = candidates.filter((c) => c.status === "matched");
  const unsure = candidates.filter((c) => c.status === "unsure");

  // The in-flight batch import for the current type (if any). Survives navigation:
  // it is derived from the server command list, not local state.
  const activeBatch = (commands ?? []).find(
    (c) =>
      c.name === "LibraryImportBatch" &&
      (c.status === "queued" || c.status === "started") &&
      c.payload?.type === type
  );
  const importing = submitting || !!activeBatch;

  // Detect the batch finishing (active → gone) and fire ONE completion toast.
  const trackedBatchIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (activeBatch) {
      trackedBatchIdRef.current = activeBatch.id;
      return;
    }
    const finishedId = trackedBatchIdRef.current;
    if (finishedId == null) return;
    trackedBatchIdRef.current = null;
    setSubmitting(false);
    const finished = (commands ?? []).find((c) => c.id === finishedId);
    if (!finished) return;
    if (finished.status === "completed") {
      // Matched rows still shown are the ones that failed; the rest imported.
      const beforeMatched = candidates.filter((c) => c.status === "matched").length;
      void refreshCandidates().then((rest) => {
        const stillMatched = rest.filter((c) => c.status === "matched").length;
        const importedCount = Math.max(0, beforeMatched - stillMatched);
        const review = rest.filter((c) => c.status === "unsure").length;
        toast.success(
          `Imported ${importedCount} title${importedCount === 1 ? "" : "s"}, ${review} still need review`
        );
      });
    } else if (finished.status === "failed") {
      toast.error("Background import failed — see Tasks for details.");
      void refreshCandidates();
    }
  }, [activeBatch, commands, candidates, refreshCandidates, toast]);

  function changeType(next: ImportType) {
    if (next === type) return;
    setType(next);
    setRootFolderId(null); // reset — falls back to the first folder of the new media type
    setScanError(null);
    setTruncated(false);
    // candidates reload via the type-change effect above.
  }

  async function runScan() {
    if (!effectiveRootFolderId) return;
    setScanning(true);
    setScanError(null);
    try {
      const res = await apiFetch<ScanResponse>(
        `/library-import/scan?type=${type}&rootFolderId=${effectiveRootFolderId}` +
          (effectiveProfileId != null ? `&qualityProfileId=${effectiveProfileId}` : "")
      );
      setCandidates(res.candidates);
      setTruncated(!!res.truncated);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  async function importAll() {
    setSubmitting(true);
    try {
      const res = await apiFetch<{ id: number | null; queued: boolean }>(
        "/library-import/import-all",
        { method: "POST", body: JSON.stringify({ type }) }
      );
      if (res.id != null) trackedBatchIdRef.current = res.id;
      await mutateCommands();
    } catch (err) {
      setSubmitting(false);
      toast.error(err instanceof ApiError ? err.message : "Could not start import");
    }
  }

  async function resetLibrary() {
    const confirmed = await confirm({
      title: "Reset library",
      message:
        "Removes all library entries from the database. Your files on disk are NOT deleted — you can re-import.",
      confirmLabel: "Reset library",
      danger: true,
    });
    if (!confirmed) return;
    setResetting(true);
    try {
      await apiFetch("/library-import/reset", { method: "POST" });
      toast.success("Library reset — everything on disk is untouched.");
      setCandidates([]);
      setScanError(null);
      setTruncated(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setResetting(false);
    }
  }

  const canScan = !scanning && effectiveRootFolderId != null && effectiveProfileId != null;
  const showEmpty =
    !scanning && !loadingCandidates && !scanError && candidates.length === 0;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Library Import</h1>
          <p className="text-sm text-zinc-400">
            Bring media already on disk into media-box without moving any files.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0 text-red-400 hover:text-red-300"
          onClick={resetLibrary}
          loading={resetting}
          disabled={resetting}
        >
          Reset library
        </Button>
      </div>

      <Callout tone="info" title="How this works">
        media-box scans the library folder you choose for titles that are not yet in your library,
        matches each against TMDB, imports the confident matches, and asks you to identify anything
        it is unsure about. Files stay exactly where they are. Coming from Sonarr or Radarr with the
        apps still running? Settings → Migrate imports straight from their APIs with exact IDs — no
        guessing.
      </Callout>

      {/* Controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <Field label="Type">
          <div className="flex gap-1">
            {(["movie", "series", "anime"] as const).map((t) => (
              <Button
                key={t}
                variant={type === t ? "primary" : "secondary"}
                onClick={() => changeType(t)}
              >
                {t === "movie" ? "Movies" : t === "anime" ? "Anime" : "Series"}
              </Button>
            ))}
          </div>
        </Field>

        <Field label="Root folder" htmlFor="li-root" className="min-w-56 flex-1">
          <Select
            id="li-root"
            value={effectiveRootFolderId ?? ""}
            onChange={(e) => setRootFolderId(Number(e.target.value))}
            disabled={folders.length === 0}
          >
            {folders.length === 0 ? (
              <option value="">No root folders</option>
            ) : (
              folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path}
                </option>
              ))
            )}
          </Select>
        </Field>

        <Field label="Quality profile" htmlFor="li-profile" className="min-w-44">
          <Select
            id="li-profile"
            value={effectiveProfileId ?? ""}
            onChange={(e) => setQualityProfileId(Number(e.target.value))}
            disabled={!profiles || profiles.length === 0}
          >
            {(profiles ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>

        <Button onClick={runScan} loading={scanning} disabled={!canScan}>
          Scan
        </Button>
      </div>

      {folders.length === 0 && (
        <Callout tone="warning">
          No {type === "movie" ? "movie" : type === "anime" ? "anime" : "series"} root folder
          configured. Add one under Settings → Media Management first
          {type === "anime" ? " (add an Anime root folder, or set the Anime library path there)" : ""}
          .
        </Callout>
      )}

      {/* States */}
      {scanning && (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Spinner className="size-4" /> Scanning… this can take a moment for large libraries.
        </div>
      )}

      {scanError && !scanning && (
        <Callout tone="danger" title="Scan failed">
          {scanError}
        </Callout>
      )}

      {truncated && (
        <Callout tone="warning" title="Showing the first 150 titles">
          This folder has more titles than one scan shows. Import these, then scan again to
          continue with the rest.
        </Callout>
      )}

      {showEmpty && (
        <EmptyState
          title="Nothing to import"
          description="Scan a root folder to find titles on disk that aren't in your library yet."
        />
      )}

      {candidates.length > 0 && !scanning && (
        <div className="space-y-8">
          {matched.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-zinc-100">
                  Ready to import
                  <span className="ml-2 font-normal text-zinc-500">{matched.length}</span>
                </h2>
                <Button
                  size="sm"
                  onClick={importAll}
                  loading={submitting && !activeBatch}
                  disabled={importing || matched.length === 0}
                >
                  Import all matched ({matched.length})
                </Button>
              </div>

              {importing && (
                <Callout tone="info" title="Importing in the background">
                  You can leave this page — the import keeps running. We&apos;ll finish it up and
                  let you know when it&apos;s done.
                </Callout>
              )}

              <div className="space-y-2">
                {matched.map((c) => {
                  const target = matchedSuggestion(c);
                  return (
                    <div
                      key={c.path}
                      className="flex items-center justify-between gap-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        {target?.poster ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={target.poster}
                            alt=""
                            loading="lazy"
                            className="h-12 w-8 shrink-0 rounded object-cover"
                          />
                        ) : (
                          <div className="h-12 w-8 shrink-0 rounded bg-zinc-800" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-zinc-100">
                            {target?.title ?? c.parsedTitle}
                            {(target?.year ?? c.parsedYear) != null && (
                              <span className="text-zinc-500"> ({target?.year ?? c.parsedYear})</span>
                            )}
                          </div>
                          <div className="truncate font-mono text-xs text-zinc-500">{c.name}</div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {c.mediaKind === "movie" && type !== "movie" && (
                          <Badge tone="neutral">Movie</Badge>
                        )}
                        <Badge tone="success">Match</Badge>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {unsure.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-zinc-100">
                Needs your input
                <span className="ml-2 font-normal text-zinc-500">{unsure.length}</span>
              </h2>
              <div className="space-y-3">
                {unsure.map((c) => (
                  <CandidateRow
                    key={c.path}
                    candidate={c}
                    type={type}
                    rootFolderId={effectiveRootFolderId!}
                    qualityProfileId={effectiveProfileId!}
                    onImported={() => void refreshCandidates()}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
