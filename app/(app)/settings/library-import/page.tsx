"use client";

import { useMemo, useRef, useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import type { QualityProfile, RootFolder } from "@/lib/types";
import type { ImportCandidate } from "@/server/library/library-import";
import {
  Button,
  Callout,
  EmptyState,
  Field,
  Select,
  Spinner,
  useConfirm,
  useToast,
} from "@/components/ui";
import { CandidateRow, type CandidateRowHandle } from "@/components/library-import-row";

type ImportType = "movie" | "series" | "anime";

/** Media type of the root folders a given import type reads from. */
function rootMediaType(type: ImportType): RootFolder["mediaType"] {
  return type === "movie" ? "movies" : type === "anime" ? "anime" : "series";
}

interface ScanResponse {
  root: string;
  candidates: ImportCandidate[];
  truncated?: boolean;
}

export default function LibraryImportPage() {
  const [type, setType] = useState<ImportType>("movie");
  // `null` means "fall back to the first available option"; lets the type toggle reset the folder.
  const [rootFolderId, setRootFolderId] = useState<number | null>(null);
  const [qualityProfileId, setQualityProfileId] = useState<number | null>(null);

  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const [importedPaths, setImportedPaths] = useState<Set<string>>(new Set());
  const [importingAll, setImportingAll] = useState(false);
  const [importAllProgress, setImportAllProgress] = useState({ done: 0, total: 0 });
  const [resetting, setResetting] = useState(false);

  const { data: rootFolders } = useApi<RootFolder[]>("/rootfolders");
  const { data: profiles } = useApi<QualityProfile[]>("/qualityprofiles");
  const toast = useToast();
  const confirm = useConfirm();

  const mediaType = rootMediaType(type);
  const folders = useMemo(
    () => (rootFolders ?? []).filter((f) => f.mediaType === mediaType),
    [rootFolders, mediaType]
  );

  const effectiveRootFolderId = rootFolderId ?? folders[0]?.id ?? null;
  const effectiveProfileId = qualityProfileId ?? profiles?.[0]?.id ?? null;

  // Handles for every matched row, so "Import all" can trigger their imports in order.
  const rowRefs = useRef(new Map<string, CandidateRowHandle>());

  function markImported(path: string) {
    setImportedPaths((prev) => new Set(prev).add(path));
  }

  function changeType(next: ImportType) {
    if (next === type) return;
    setType(next);
    setRootFolderId(null); // reset — falls back to the first folder of the new media type
    setScan(null);
    setScanError(null);
    setImportedPaths(new Set());
  }

  async function runScan() {
    if (!effectiveRootFolderId) return;
    setScanning(true);
    setScan(null);
    setScanError(null);
    setImportedPaths(new Set());
    rowRefs.current.clear();
    try {
      const res = await apiFetch<ScanResponse>(
        `/library-import/scan?type=${type}&rootFolderId=${effectiveRootFolderId}`
      );
      setScan(res);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  const candidates = scan?.candidates ?? [];
  const matched = candidates.filter((c) => c.status === "matched");
  const unsure = candidates.filter((c) => c.status === "unsure");
  const pendingMatched = matched.filter((c) => !importedPaths.has(c.path));

  async function importAll() {
    setImportingAll(true);
    const pending = matched.filter((c) => !importedPaths.has(c.path));
    setImportAllProgress({ done: 0, total: pending.length });
    let done = 0;
    for (const c of pending) {
      const handle = rowRefs.current.get(c.path);
      if (handle) await handle.importSelected();
      done += 1;
      setImportAllProgress({ done, total: pending.length });
    }
    setImportingAll(false);
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
      setScan(null);
      setScanError(null);
      setImportedPaths(new Set());
      rowRefs.current.clear();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setResetting(false);
    }
  }

  const canScan = !scanning && effectiveRootFolderId != null && effectiveProfileId != null;

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
        it is unsure about. Files stay exactly where they are.
      </Callout>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
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

      {scan && !scanning && (
        <>
          {scan.truncated && (
            <Callout tone="warning" title="Showing the first 150 titles">
              This folder has more titles than one scan shows. Import these, then scan again to
              continue with the rest.
            </Callout>
          )}
          {candidates.length === 0 ? (
            <EmptyState
              title="Nothing to import"
              description="Every folder here is already in your library (or has no video files)."
            />
          ) : (
            <div className="space-y-8">
              {matched.length > 0 && (
                <section className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold text-zinc-100">
                      Ready to import
                      <span className="ml-2 font-normal text-zinc-500">
                        {pendingMatched.length} pending
                      </span>
                    </h2>
                    <Button
                      size="sm"
                      onClick={importAll}
                      loading={importingAll}
                      disabled={importingAll || pendingMatched.length === 0}
                    >
                      {importingAll
                        ? `Importing… (${importAllProgress.done}/${importAllProgress.total})`
                        : "Import all"}
                    </Button>
                  </div>
                  <div className="space-y-3">
                    {matched.map((c) => (
                      <CandidateRow
                        key={c.path}
                        candidate={c}
                        type={type}
                        rootFolderId={effectiveRootFolderId!}
                        qualityProfileId={effectiveProfileId!}
                        onImported={markImported}
                        ref={(h) => {
                          if (h) rowRefs.current.set(c.path, h);
                          else rowRefs.current.delete(c.path);
                        }}
                      />
                    ))}
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
                        onImported={markImported}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
