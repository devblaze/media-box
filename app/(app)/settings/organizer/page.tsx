"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiFetch, useApi } from "@/lib/api";
import { formatBytes, type MovieSummary, type SeriesSummary } from "@/lib/types";
import type { OrganizeItem } from "@/server/library/organizer-service";
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  EmptyState,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  useToast,
} from "@/components/ui";
import { cn } from "@/lib/cn";

// ---------- shared shapes ----------

interface ScanResponse {
  root: string;
  items: OrganizeItem[];
}

/** One entry POSTed to /organizer/organize/bulk. */
interface BulkItem {
  sourcePath: string;
  kind: "series" | "anime" | "movie";
  id: number;
  seasonNumber?: number;
  episodeNumbers?: number[];
}

interface BulkResultRow {
  sourcePath: string;
  status: "organized" | "failed" | "skipped";
  detail?: string | null;
  error?: string;
}

interface BulkResponse {
  organized: number;
  failed: number;
  skipped: number;
  results: BulkResultRow[];
}

interface OrganizeLogRow {
  id: number;
  sourcePath: string;
  destPath: string | null;
  mediaType: "movie" | "series" | "anime" | null;
  title: string | null;
  detail: string | null;
  action: string | null;
  status: "organized" | "failed" | "skipped";
  message: string | null;
  createdAt: number | string;
}

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
type FileCategory = "movies" | "series" | "anime" | "unknown";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "S01E03" / "S01E03E04" for a season + episode list, else null. */
function formatSxxExx(season: number | null, episodes: number[]): string | null {
  if (season == null || episodes.length === 0) return null;
  return `S${pad2(season)}${[...episodes]
    .sort((a, b) => a - b)
    .map((e) => `E${pad2(e)}`)
    .join("")}`;
}

/** The UI category (drives the type badge + the Type filter). */
function categoryOf(item: OrganizeItem): FileCategory {
  if (item.type === "movie") return "movies";
  if (item.type === "episode") return item.match.kind === "anime" ? "anime" : "series";
  return "unknown";
}

const CATEGORY_BADGE: Record<FileCategory, { label: string; tone: BadgeTone }> = {
  movies: { label: "Movie", tone: "info" },
  series: { label: "Series", tone: "accent" },
  anime: { label: "Anime", tone: "success" },
  unknown: { label: "Unknown", tone: "neutral" },
};

const STATUS_TONE: Record<OrganizeLogRow["status"], BadgeTone> = {
  organized: "success",
  failed: "danger",
  skipped: "neutral",
};

/** Checkbox that can render the tri-state "indeterminate" dash (native only via ref). */
function TriStateCheckbox({
  checked,
  indeterminate,
  ...props
}: React.ComponentProps<"input"> & { indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate) && !checked;
  }, [indeterminate, checked]);
  return <Checkbox ref={ref} checked={checked} {...props} />;
}

/** The "filename → S01E05" mapping for assigning a file to a chosen series. */
function episodeMappingOf(item: OrganizeItem): string | null {
  if (item.type !== "episode") return null;
  return formatSxxExx(item.season, item.episodes);
}

// ================= page =================

export default function OrganizerPage() {
  const [tab, setTab] = useState<"files" | "log">("files");

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Downloads Organizer</h1>
        <p className="text-sm text-zinc-400">
          Scan your downloads folder for loose video files and file each into the library, renamed by
          your naming convention. Non-destructive by default (hardlink/copy) — your download is kept.
        </p>
      </div>

      <div className="flex gap-1 border-b border-zinc-800">
        {(["files", "log"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors",
              tab === t
                ? "border-amber-500 text-amber-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            )}
          >
            {t === "files" ? "Files" : "Log"}
          </button>
        ))}
      </div>

      {tab === "files" ? <FilesTab /> : <LogTab />}
    </div>
  );
}

// ================= files tab =================

function FilesTab() {
  const toast = useToast();
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [organized, setOrganized] = useState<Set<string>>(new Set());

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | FileCategory>("all");
  const [matchFilter, setMatchFilter] = useState<"all" | "matched" | "unmatched">("all");

  // --- bulk / multi-select state ---
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkSeriesId, setBulkSeriesId] = useState<number | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkErrors, setBulkErrors] = useState<{ sourcePath: string; error: string }[]>([]);
  // "Organize all matched" replace-vs-skip prompt.
  const [askExisting, setAskExisting] = useState(false);

  const { data: series } = useApi<SeriesSummary[]>("/series");
  const { data: movies } = useApi<MovieSummary[]>("/movies");

  async function runScan() {
    setScanning(true);
    setScan(null);
    setScanError(null);
    setOrganized(new Set());
    setSelected(new Set());
    setBulkErrors([]);
    setBulkSeriesId(null);
    try {
      const res = await apiFetch<ScanResponse>("/organizer/scan");
      setScan(res);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  function markOrganized(sourcePath: string) {
    setOrganized((prev) => new Set(prev).add(sourcePath));
  }

  function markOrganizedMany(paths: string[]) {
    if (paths.length === 0) return;
    setOrganized((prev) => {
      const next = new Set(prev);
      for (const p of paths) next.add(p);
      return next;
    });
  }

  function toggleSelect(sourcePath: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sourcePath)) next.delete(sourcePath);
      else next.add(sourcePath);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
    setBulkSeriesId(null);
  }

  const items = useMemo(() => scan?.items ?? [], [scan]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (q && !`${item.name} ${item.parsedTitle}`.toLowerCase().includes(q)) return false;
      const cat = categoryOf(item);
      if (typeFilter !== "all" && cat !== typeFilter) return false;
      const matched = item.match.kind !== "none" && item.match.id != null;
      if (matchFilter === "matched" && !matched) return false;
      if (matchFilter === "unmatched" && matched) return false;
      return true;
    });
  }, [items, search, typeFilter, matchFilter]);

  // Only not-yet-organized, not-already-organized rows can be (de)selected.
  const selectableVisible = useMemo(
    () => visible.filter((i) => !i.alreadyOrganized && !organized.has(i.sourcePath)),
    [visible, organized]
  );
  // The set the bulk bar acts on: filtered ∩ selectable ∩ selected.
  const selectedItems = useMemo(
    () => selectableVisible.filter((i) => selected.has(i.sourcePath)),
    [selectableVisible, selected]
  );
  const allSelected =
    selectableVisible.length > 0 && selectableVisible.every((i) => selected.has(i.sourcePath));
  const someSelected = selectableVisible.some((i) => selected.has(i.sourcePath));

  const bulkSeries = useMemo(
    () => (series ?? []).find((s) => s.id === bulkSeriesId) ?? null,
    [series, bulkSeriesId]
  );
  const assignMappable = useMemo(
    () => selectedItems.filter((i) => episodeMappingOf(i) != null),
    [selectedItems]
  );

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      const paths = selectableVisible.map((i) => i.sourcePath);
      if (paths.length > 0 && paths.every((p) => next.has(p))) {
        for (const p of paths) next.delete(p);
      } else {
        for (const p of paths) next.add(p);
      }
      return next;
    });
  }

  async function runBulk(bulkItems: BulkItem[], notSent = 0, onExisting?: "replace" | "skip") {
    if (bulkItems.length === 0) return;
    setBulkRunning(true);
    try {
      const res = await apiFetch<BulkResponse>("/organizer/organize/bulk", {
        method: "POST",
        body: JSON.stringify({ items: bulkItems, ...(onExisting ? { onExisting } : {}) }),
      });
      // Organized (and "already in the library" / "already has a file" skips)
      // drop out of the list — they're resolved, not problems.
      const skipText = (r: BulkResultRow) => r.error ?? r.detail ?? "";
      const donePaths = res.results
        .filter((r) => r.status === "organized" || (r.status === "skipped" && /already/i.test(skipText(r))))
        .map((r) => r.sourcePath);
      markOrganizedMany(donePaths);
      // Real problems (failures + "not in the library" skips) get surfaced.
      const errs = res.results
        .filter((r) => r.status === "failed" || (r.status === "skipped" && !/already/i.test(skipText(r))))
        .map((r) => ({ sourcePath: r.sourcePath, error: r.error ?? r.detail ?? "Unknown error" }));
      setBulkErrors(errs);

      let msg = `Organized ${res.organized} · skipped ${res.skipped} · failed ${res.failed}`;
      if (notSent > 0) msg += ` · ${notSent} not mappable`;
      if (res.failed > 0) toast.error(msg);
      else toast.success(msg);

      clearSelection();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk organize failed");
    } finally {
      setBulkRunning(false);
    }
  }

  /** Assign every mappable selected file to the chosen series (its own S/E). */
  function assignSelectedToSeries() {
    if (!bulkSeries) return;
    if (assignMappable.length === 0) {
      toast.error("No selected file has a season/episode to map");
      return;
    }
    const bulkItems: BulkItem[] = assignMappable.map((f) => ({
      sourcePath: f.sourcePath,
      kind: bulkSeries.isAnime ? "anime" : "series",
      id: bulkSeries.id,
      seasonNumber: f.season as number,
      episodeNumbers: f.episodes,
    }));
    runBulk(bulkItems, selectedItems.length - assignMappable.length);
  }

  /** Organize selected files using each file's own detected library match. */
  function organizeSelectedAuto() {
    const matched = selectedItems.filter((f) => f.match.kind !== "none" && f.match.id != null);
    const notSent = selectedItems.length - matched.length;
    if (matched.length === 0) {
      toast.error("None of the selected files have a library match");
      return;
    }
    const bulkItems: BulkItem[] = matched.map((f) => ({
      sourcePath: f.sourcePath,
      kind: f.match.kind as "series" | "anime" | "movie",
      id: f.match.id as number,
      seasonNumber: f.season ?? undefined,
      episodeNumbers: f.episodes.length ? f.episodes : undefined,
    }));
    runBulk(bulkItems, notSent);
  }

  // Every visible, not-yet-organized file with a confident library match — what
  // the one-click "Organize all matched" button acts on (respects the filters).
  const allMatched = useMemo(
    () => selectableVisible.filter((f) => f.match.kind !== "none" && f.match.id != null),
    [selectableVisible]
  );

  /** One-click organize of every matched file. Asks replace-vs-skip first. */
  function organizeAllMatched(onExisting: "replace" | "skip") {
    setAskExisting(false);
    const bulkItems: BulkItem[] = allMatched.map((f) => ({
      sourcePath: f.sourcePath,
      kind: f.match.kind as "series" | "anime" | "movie",
      id: f.match.id as number,
      seasonNumber: f.season ?? undefined,
      episodeNumbers: f.episodes.length ? f.episodes : undefined,
    }));
    runBulk(bulkItems, 0, onExisting);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={runScan} loading={scanning}>
          Scan downloads
        </Button>
        {scan && (
          <span className="text-xs text-zinc-500">
            {scan.root ? (
              <>
                Scanned <code className="rounded bg-zinc-800 px-1 py-0.5">{scan.root}</code> —{" "}
                {items.length} file{items.length === 1 ? "" : "s"}
              </>
            ) : (
              "No downloads path configured"
            )}
          </span>
        )}
      </div>

      {scan && !scan.root && (
        <Callout tone="warning" title="No downloads folder set">
          Set the downloads path under Settings → Media Management, then scan again.
        </Callout>
      )}

      {scanError && (
        <Callout tone="danger" title="Scan failed">
          {scanError}
        </Callout>
      )}

      {scanning && (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Spinner className="size-4" /> Scanning downloads…
        </div>
      )}

      {scan && items.length > 0 && (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search filename or title…"
              className="w-full sm:max-w-xs"
            />
            <Select
              aria-label="Filter by type"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
              className="w-full sm:w-36"
            >
              <option value="all">All types</option>
              <option value="movies">Movies</option>
              <option value="series">Series</option>
              <option value="anime">Anime</option>
              <option value="unknown">Unknown</option>
            </Select>
            <Select
              aria-label="Filter by match"
              value={matchFilter}
              onChange={(e) => setMatchFilter(e.target.value as typeof matchFilter)}
              className="w-full sm:w-36"
            >
              <option value="all">Matched &amp; not</option>
              <option value="matched">Matched</option>
              <option value="unmatched">Unmatched</option>
            </Select>
            <Button
              onClick={() => setAskExisting(true)}
              disabled={allMatched.length === 0 || bulkRunning}
              loading={bulkRunning}
              className="sm:ml-auto"
            >
              Organize all matched ({allMatched.length})
            </Button>
          </div>

          {selectedItems.length > 0 && (
            <div className="sticky top-0 z-10 space-y-3 rounded-lg border border-amber-500/30 bg-zinc-950/95 p-3 shadow-lg backdrop-blur">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium text-zinc-100">
                  {selectedItems.length} selected
                </span>
                <Button size="sm" variant="ghost" onClick={clearSelection} disabled={bulkRunning}>
                  Clear
                </Button>
                <div className="ml-auto">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={organizeSelectedAuto}
                    loading={bulkRunning}
                  >
                    Organize selected (auto-match)
                  </Button>
                </div>
              </div>

              <div className="space-y-2 border-t border-zinc-800 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-zinc-400">Assign all to a series:</span>
                  <Select
                    aria-label="Assign selected files to a series"
                    value={bulkSeriesId ?? ""}
                    onChange={(e) => setBulkSeriesId(e.target.value ? Number(e.target.value) : null)}
                    className="min-w-64"
                  >
                    <option value="">Select a series / anime…</option>
                    {(series ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                        {s.year ? ` (${s.year})` : ""}
                        {s.isAnime ? " — anime" : ""}
                      </option>
                    ))}
                  </Select>
                  {bulkSeries && (
                    <Button
                      size="sm"
                      onClick={assignSelectedToSeries}
                      loading={bulkRunning}
                      disabled={assignMappable.length === 0}
                    >
                      Assign &amp; organize {assignMappable.length}
                    </Button>
                  )}
                </div>

                {bulkSeries && (
                  <ul className="max-h-44 space-y-1 overflow-auto rounded border border-zinc-800 bg-zinc-900/40 p-2 text-xs">
                    {selectedItems.map((f) => {
                      const sxe = episodeMappingOf(f);
                      return (
                        <li key={f.sourcePath} className="flex items-center gap-2 font-mono">
                          <span className="min-w-0 flex-1 truncate text-zinc-400" title={f.name}>
                            {f.name}
                          </span>
                          <span className="text-zinc-600">→</span>
                          {sxe ? (
                            <span className="shrink-0 text-emerald-300">{sxe}</span>
                          ) : (
                            <span className="shrink-0 text-amber-400">can&apos;t map — no episode</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          )}

          {bulkErrors.length > 0 && (
            <Callout tone="danger" title={`${bulkErrors.length} file${bulkErrors.length === 1 ? "" : "s"} couldn't be organized`}>
              <details>
                <summary className="cursor-pointer select-none text-sm text-red-300">
                  Show details
                </summary>
                <ul className="mt-2 space-y-1 text-xs">
                  {bulkErrors.map((e) => (
                    <li key={e.sourcePath}>
                      <span className="font-mono text-zinc-300">{basename(e.sourcePath)}</span>
                      <span className="text-red-300"> — {e.error}</span>
                    </li>
                  ))}
                </ul>
              </details>
              <div className="mt-2">
                <Button size="sm" variant="ghost" onClick={() => setBulkErrors([])}>
                  Dismiss
                </Button>
              </div>
            </Callout>
          )}

          {visible.length === 0 ? (
            <EmptyState title="No files match your filters" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH className="w-8">
                    <TriStateCheckbox
                      checked={allSelected}
                      indeterminate={someSelected}
                      disabled={selectableVisible.length === 0}
                      onChange={toggleSelectAll}
                      aria-label="Select all filtered files"
                    />
                  </TH>
                  <TH>File</TH>
                  <TH className="w-24">Type</TH>
                  <TH>Detected</TH>
                  <TH>Library match</TH>
                  <TH className="w-20">Size</TH>
                  <TH className="w-24" />
                </TR>
              </THead>
              <TBody>
                {visible.map((item) => (
                  <FileRow
                    key={item.sourcePath}
                    item={item}
                    series={series ?? []}
                    movies={movies ?? []}
                    done={organized.has(item.sourcePath)}
                    selected={selected.has(item.sourcePath)}
                    onToggleSelect={toggleSelect}
                    onOrganized={markOrganized}
                  />
                ))}
              </TBody>
            </Table>
          )}
        </>
      )}

      {scan && items.length === 0 && scan.root && (
        <EmptyState
          title="No loose files found"
          description="No un-organized video files in your downloads folder."
        />
      )}

      {/* Replace-vs-skip prompt for "Organize all matched". */}
      <Modal
        open={askExisting}
        onClose={() => setAskExisting(false)}
        title={`Organize ${allMatched.length} matched file${allMatched.length === 1 ? "" : "s"}`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAskExisting(false)}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => organizeAllMatched("skip")}>
              Skip existing
            </Button>
            <Button onClick={() => organizeAllMatched("replace")}>Replace existing</Button>
          </>
        }
      >
        <p className="text-sm text-zinc-300">
          Each file is organized into its matched movie/series. If a title{" "}
          <strong>already has a file</strong>, should the new file replace it (the old file is
          deleted) or be skipped (the existing file is kept)?
        </p>
      </Modal>
    </div>
  );
}

// ---------- one file row ----------

function FileRow({
  item,
  series,
  movies,
  done,
  selected,
  onToggleSelect,
  onOrganized,
}: {
  item: OrganizeItem;
  series: SeriesSummary[];
  movies: MovieSummary[];
  done: boolean;
  selected: boolean;
  onToggleSelect: (sourcePath: string) => void;
  onOrganized: (sourcePath: string) => void;
}) {
  const toast = useToast();
  const [organizing, setOrganizing] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const hasMatch = item.match.kind !== "none" && item.match.id != null;
  const cat = categoryOf(item);
  const badge = CATEGORY_BADGE[cat];
  const sxe = formatSxxExx(item.season, item.episodes);

  // Manual-assignment state (only used when there is no library match).
  const [assignKind, setAssignKind] = useState<"series" | "movie">(
    item.type === "movie" ? "movie" : "series"
  );
  const [assignSearch, setAssignSearch] = useState("");
  const [assignId, setAssignId] = useState<number | null>(null);
  const [assignSeason, setAssignSeason] = useState<string>(
    item.season != null ? String(item.season) : "1"
  );
  const [assignEpisodes, setAssignEpisodes] = useState<string>(
    item.episodes.length ? item.episodes.join(", ") : ""
  );

  const assignList = assignKind === "movie" ? movies : series;
  const filteredAssign = useMemo(() => {
    const q = assignSearch.trim().toLowerCase();
    const rows = q
      ? assignList.filter((r) => r.title.toLowerCase().includes(q))
      : assignList;
    return rows.slice(0, 50);
  }, [assignList, assignSearch]);

  function parseEpisodeInput(): number[] {
    return assignEpisodes
      .split(/[,\s]+/)
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  function buildBody(): Record<string, unknown> | null {
    if (hasMatch) {
      if (item.match.kind === "movie") {
        return { sourcePath: item.sourcePath, kind: "movie", id: item.match.id };
      }
      return {
        sourcePath: item.sourcePath,
        kind: item.match.kind,
        id: item.match.id,
        seasonNumber: item.season ?? undefined,
        episodeNumbers: item.episodes,
      };
    }
    // manual assignment
    if (assignId == null) return null;
    if (assignKind === "movie") {
      return { sourcePath: item.sourcePath, kind: "movie", id: assignId };
    }
    const episodeNumbers = parseEpisodeInput();
    const seasonNumber = parseInt(assignSeason, 10);
    if (!Number.isFinite(seasonNumber) || episodeNumbers.length === 0) return null;
    return {
      sourcePath: item.sourcePath,
      kind: "series",
      id: assignId,
      seasonNumber,
      episodeNumbers,
    };
  }

  async function organize() {
    const body = buildBody();
    if (!body) {
      toast.error("Pick a title (and season/episode) first");
      return;
    }
    setOrganizing(true);
    try {
      const res = await apiFetch<{ title: string; detail: string | null; action: string }>(
        "/organizer/organize",
        { method: "POST", body: JSON.stringify(body) }
      );
      toast.success(
        `Organized → ${res.title}${res.detail ? ` ${res.detail}` : ""} (${res.action})`
      );
      onOrganized(item.sourcePath);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.info(err.message);
        onOrganized(item.sourcePath);
      } else {
        toast.error(err instanceof Error ? err.message : "Organize failed");
      }
    } finally {
      setOrganizing(false);
    }
  }

  const dim = done || item.alreadyOrganized;
  const canOrganize = hasMatch || buildBody() != null;

  return (
    <>
      <TR className={cn("align-top", dim && "opacity-50")}>
        <TD className="w-8">
          <Checkbox
            checked={selected && !dim}
            disabled={dim}
            onChange={() => onToggleSelect(item.sourcePath)}
            aria-label={`Select ${item.name}`}
          />
        </TD>
        <TD className="max-w-xs">
          <div className="truncate font-mono text-xs text-zinc-300" title={item.name}>
            {item.name}
          </div>
          {item.alreadyOrganized && (
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">
              Already organized
            </span>
          )}
        </TD>
        <TD>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </TD>
        <TD>
          <div className="text-zinc-200">
            {item.parsedTitle || "—"}
            {item.year ? <span className="text-zinc-500"> ({item.year})</span> : null}
          </div>
          {sxe && <div className="font-mono text-xs text-zinc-500">{sxe}</div>}
        </TD>
        <TD>
          {hasMatch ? (
            <div className="text-emerald-300">{item.match.title}</div>
          ) : done ? (
            <span className="text-emerald-400">Organized ✓</span>
          ) : (
            <button
              type="button"
              onClick={() => setAssigning((v) => !v)}
              className="text-amber-400 underline decoration-dotted hover:text-amber-300"
            >
              {assigning ? "Cancel" : "No match — Assign…"}
            </button>
          )}
        </TD>
        <TD className="whitespace-nowrap text-xs text-zinc-400">{formatBytes(item.size)}</TD>
        <TD>
          {done ? (
            <span className="text-xs text-emerald-400">Done</span>
          ) : (
            <Button size="sm" onClick={organize} loading={organizing} disabled={!canOrganize}>
              Organize
            </Button>
          )}
        </TD>
      </TR>

      {assigning && !hasMatch && !done && (
        <TR className="bg-zinc-900/40">
          <TD colSpan={7}>
            <div className="space-y-3 py-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex gap-1">
                  {(["series", "movie"] as const).map((k) => (
                    <Button
                      key={k}
                      size="sm"
                      variant={assignKind === k ? "primary" : "secondary"}
                      onClick={() => {
                        setAssignKind(k);
                        setAssignId(null);
                      }}
                    >
                      {k === "series" ? "Series / Anime" : "Movie"}
                    </Button>
                  ))}
                </div>
                <Input
                  value={assignSearch}
                  onChange={(e) => setAssignSearch(e.target.value)}
                  placeholder={`Filter ${assignKind === "movie" ? "movies" : "series"}…`}
                  className="max-w-xs"
                />
                <Select
                  aria-label="Pick a title"
                  value={assignId ?? ""}
                  onChange={(e) => setAssignId(e.target.value ? Number(e.target.value) : null)}
                  className="min-w-56"
                >
                  <option value="">Select a title…</option>
                  {filteredAssign.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                      {r.year ? ` (${r.year})` : ""}
                    </option>
                  ))}
                </Select>
              </div>

              {assignKind === "series" && (
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-xs text-zinc-400">
                    <span className="mb-1 block">Season</span>
                    <Input
                      value={assignSeason}
                      onChange={(e) => setAssignSeason(e.target.value)}
                      inputMode="numeric"
                      className="w-20"
                    />
                  </label>
                  <label className="text-xs text-zinc-400">
                    <span className="mb-1 block">Episode(s)</span>
                    <Input
                      value={assignEpisodes}
                      onChange={(e) => setAssignEpisodes(e.target.value)}
                      placeholder="e.g. 3 or 3, 4"
                      className="w-40"
                    />
                  </label>
                </div>
              )}
            </div>
          </TD>
        </TR>
      )}
    </>
  );
}

// ================= log tab =================

function LogTab() {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [typeFilter, setTypeFilter] = useState<"" | "movie" | "series" | "anime">("");
  const [statusFilter, setStatusFilter] = useState<"" | "organized" | "failed" | "skipped">("");

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: "500" });
    if (debounced) params.set("q", debounced);
    if (typeFilter) params.set("type", typeFilter);
    if (statusFilter) params.set("status", statusFilter);
    return `/organizer/log?${params.toString()}`;
  }, [debounced, typeFilter, statusFilter]);

  const { data: rows, isLoading, mutate } = useApi<OrganizeLogRow[]>(query);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search source, title or episode…"
          className="w-full sm:max-w-xs"
        />
        <Select
          aria-label="Filter log by type"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
          className="w-full sm:w-36"
        >
          <option value="">All types</option>
          <option value="movie">Movies</option>
          <option value="series">Series</option>
          <option value="anime">Anime</option>
        </Select>
        <Select
          aria-label="Filter log by status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="w-full sm:w-36"
        >
          <option value="">All statuses</option>
          <option value="organized">Organized</option>
          <option value="failed">Failed</option>
          <option value="skipped">Skipped</option>
        </Select>
        <Button variant="secondary" size="sm" onClick={() => mutate()}>
          Refresh
        </Button>
      </div>

      {isLoading && !rows ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Spinner className="size-4" /> Loading log…
        </div>
      ) : !rows || rows.length === 0 ? (
        <EmptyState
          title="No log entries"
          description="Files you organize into the library appear here."
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH className="w-40">Time</TH>
              <TH>Source</TH>
              <TH>Matched</TH>
              <TH className="w-24">Action</TH>
              <TH className="w-24">Status</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.id} className="align-top">
                <TD className="whitespace-nowrap text-xs text-zinc-400">
                  {new Date(row.createdAt).toLocaleString()}
                </TD>
                <TD className="max-w-xs">
                  <div className="truncate font-mono text-xs text-zinc-300" title={row.sourcePath}>
                    {basename(row.sourcePath)}
                  </div>
                  {row.status === "failed" && row.message && (
                    <div className="text-xs text-red-400">{row.message}</div>
                  )}
                </TD>
                <TD>
                  {row.title ? (
                    <span className="text-zinc-200">
                      {row.title}
                      {row.detail ? (
                        <span className="ml-1 font-mono text-xs text-zinc-500">{row.detail}</span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </TD>
                <TD className="text-xs text-zinc-400">{row.action ?? "—"}</TD>
                <TD>
                  <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}
