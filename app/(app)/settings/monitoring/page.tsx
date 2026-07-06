"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch, useApi } from "@/lib/api";
import { tmdbPoster } from "@/lib/types";
import type { MovieSummary, SeriesSummary } from "@/lib/types";
import { Button, Checkbox, EmptyState, Input, Select, Skeleton, useToast } from "@/components/ui";
import { MonitorToggle } from "@/components/monitor-toggle";
import { cn } from "@/lib/cn";

type TabKey = "movies" | "series" | "anime";
type ApiType = "movie" | "series";
type MonitorMode = "all" | "future" | "none";
type MonitorFilter = "all" | "monitored" | "unmonitored";
type ViewMode = "list" | "tiles";
type SortKey = "title" | "added" | "imported";

interface Row {
  id: number;
  apiType: ApiType;
  title: string;
  year: number | null;
  posterPath: string | null;
  monitored: boolean;
  monitorMode?: MonitorMode;
  addedAt: number;
  importedAt: number | null;
}

const TABS: { key: TabKey; label: string }[] = [
  { key: "movies", label: "Movies" },
  { key: "series", label: "Series" },
  { key: "anime", label: "Anime" },
];

const MODES: { value: MonitorMode; label: string }[] = [
  { value: "all", label: "All" },
  { value: "future", label: "Future" },
  { value: "none", label: "None" },
];

/** Responsive poster grid used by the Tiles view (and its loading skeleton). */
const TILE_GRID =
  "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";

/** The bulk endpoint uses "series" for both Series and Anime rows (anime is a series flag). */
function apiTypeFor(tab: TabKey): ApiType {
  return tab === "movies" ? "movie" : "series";
}

/** Detail page for a row — movies drill into /movies/:id, series & anime into /series/:id. */
function detailHref(row: Row): string {
  return row.apiType === "movie" ? `/movies/${row.id}` : `/series/${row.id}`;
}

function ListIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

/** List / Tiles segmented control — page-level view preference. */
function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  const options: { value: ViewMode; label: string; icon: React.ReactNode }[] = [
    { value: "list", label: "List", icon: <ListIcon /> },
    { value: "tiles", label: "Tiles", icon: <GridIcon /> },
  ];
  return (
    <div
      role="group"
      aria-label="View"
      className="inline-flex shrink-0 overflow-hidden rounded-md border border-zinc-800 bg-zinc-900/50"
    >
      {options.map((o) => {
        const on = view === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={on}
            title={`${o.label} view`}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors",
              on
                ? "bg-amber-500 text-zinc-950"
                : "text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100"
            )}
          >
            {o.icon}
            <span className="hidden sm:inline">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** All / Future / None monitor-mode control (series & anime rows). */
function ModeButtons({
  value,
  disabled,
  onSelect,
  fill,
}: {
  value: MonitorMode;
  disabled?: boolean;
  onSelect: (mode: MonitorMode) => void;
  fill?: boolean;
}) {
  return (
    <div
      className={cn(
        "inline-flex overflow-hidden rounded-md border border-zinc-700",
        fill && "flex w-full"
      )}
    >
      {MODES.map((m) => {
        const on = value === m.value;
        return (
          <button
            key={m.value}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(m.value)}
            aria-pressed={on}
            title={`Monitor ${m.label.toLowerCase()} episodes`}
            className={cn(
              "px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50",
              fill && "flex-1",
              on ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            )}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

export default function MonitoringPage() {
  const { data: series, mutate: mutateSeries } = useApi<SeriesSummary[]>("/series");
  const { data: movies, mutate: mutateMovies } = useApi<MovieSummary[]>("/movies");
  const toast = useToast();

  const [tab, setTab] = useState<TabKey>("movies");
  const [view, setView] = useState<ViewMode>("list");
  const [search, setSearch] = useState("");
  const [monitorFilter, setMonitorFilter] = useState<MonitorFilter>("all");
  const [sort, setSort] = useState<SortKey>("title");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [savingIds, setSavingIds] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const loading = series === undefined || movies === undefined;

  // Split the two sources into the three tab buckets once.
  const rowsByTab = useMemo(() => {
    const movieRows: Row[] = (movies ?? []).map((m) => ({
      id: m.id,
      apiType: "movie",
      title: m.title,
      year: m.year,
      posterPath: m.posterPath,
      monitored: m.monitored,
      addedAt: m.addedAt,
      importedAt: m.importedAt,
    }));
    const seriesRows: Row[] = [];
    const animeRows: Row[] = [];
    for (const s of series ?? []) {
      const row: Row = {
        id: s.id,
        apiType: "series",
        title: s.title,
        year: s.year,
        posterPath: s.posterPath,
        monitored: s.monitored,
        monitorMode: s.monitorMode,
        addedAt: s.addedAt,
        importedAt: s.importedAt,
      };
      (s.isAnime ? animeRows : seriesRows).push(row);
    }
    return { movies: movieRows, series: seriesRows, anime: animeRows };
  }, [movies, series]);

  const counts = useMemo(() => {
    const mk = (rows: Row[]) => ({
      total: rows.length,
      monitored: rows.reduce((n, r) => n + (r.monitored ? 1 : 0), 0),
    });
    return {
      movies: mk(rowsByTab.movies),
      series: mk(rowsByTab.series),
      anime: mk(rowsByTab.anime),
    };
  }, [rowsByTab]);

  const activeRows = rowsByTab[tab];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activeRows
      .filter((r) => {
        if (monitorFilter === "monitored" && !r.monitored) return false;
        if (monitorFilter === "unmonitored" && r.monitored) return false;
        if (q && !r.title.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        // Newest-first for the time sorts; title A→Z otherwise (and as tiebreak).
        if (sort === "added") return b.addedAt - a.addedAt || a.title.localeCompare(b.title);
        if (sort === "imported")
          return (b.importedAt ?? 0) - (a.importedAt ?? 0) || a.title.localeCompare(b.title);
        return a.title.localeCompare(b.title);
      });
  }, [activeRows, search, monitorFilter, sort]);

  const filteredIds = useMemo(() => filtered.map((r) => r.id), [filtered]);
  const allSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));
  const someSelected = !allSelected && filteredIds.some((id) => selected.has(id));

  const setSelectAllRef = (el: HTMLInputElement | null) => {
    if (el) el.indeterminate = someSelected;
  };

  function switchTab(next: TabKey) {
    if (next === tab) return;
    setTab(next);
    // Selection + search are per-tab: start each tab fresh. (View preference persists.)
    setSelected(new Set());
    setSearch("");
    setMonitorFilter("all");
    setSort("title");
  }

  function toggleRow(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) filteredIds.forEach((id) => next.delete(id));
      else filteredIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function markSaving(id: number, on: boolean) {
    setSavingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function refetchFor(apiType: ApiType) {
    await (apiType === "movie" ? mutateMovies() : mutateSeries());
  }

  async function applyBulk(ids: number[], monitored: boolean) {
    if (ids.length === 0) return;
    const apiType = apiTypeFor(tab);
    const items = ids.map((id) => ({ type: apiType, id, monitored }));
    setBusy(true);
    try {
      const res = await apiFetch<{ updated: number }>("/monitoring/bulk", {
        method: "POST",
        body: JSON.stringify({ items }),
      });
      await refetchFor(apiType);
      setSelected(new Set());
      toast.success(
        `${monitored ? "Monitoring" : "Unmonitored"} ${res.updated} item${res.updated === 1 ? "" : "s"}`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk update failed");
    } finally {
      setBusy(false);
    }
  }

  async function applyBulkMode(ids: number[], mode: MonitorMode) {
    if (ids.length === 0) return;
    // Monitor mode only applies to series (Series + Anime tabs), so type is always "series".
    const items = ids.map((id) => ({ type: "series" as ApiType, id }));
    setBusy(true);
    try {
      const res = await apiFetch<{ updated: number }>("/monitoring/bulk", {
        method: "POST",
        body: JSON.stringify({ items, monitorMode: mode }),
      });
      await mutateSeries();
      setSelected(new Set());
      const label = MODES.find((m) => m.value === mode)?.label ?? mode;
      toast.success(
        `Set ${res.updated} series to ${label}`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk update failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleMonitored(row: Row) {
    markSaving(row.id, true);
    try {
      await apiFetch(`/${row.apiType === "movie" ? "movies" : "series"}/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({ monitored: !row.monitored }),
      });
      await refetchFor(row.apiType);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      markSaving(row.id, false);
    }
  }

  async function changeMode(row: Row, mode: MonitorMode) {
    if (mode === (row.monitorMode ?? "all")) return;
    markSaving(row.id, true);
    try {
      await apiFetch(`/series/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({ monitorMode: mode }),
      });
      await mutateSeries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      markSaving(row.id, false);
    }
  }

  const active = counts[tab];

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Monitoring</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Choose what media-box tracks. Monitored items are searched and grabbed automatically.
          </p>
        </div>
        <ViewToggle view={view} onChange={setView} />
      </div>

      {/* Tabs — one per media kind, with total + monitored counts */}
      <div className="flex w-full gap-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-1">
        {TABS.map((t) => {
          const c = counts[t.key];
          const isActive = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => switchTab(t.key)}
              aria-pressed={isActive}
              className={cn(
                "flex flex-1 flex-col items-center rounded-md px-2 py-2 transition-colors",
                isActive
                  ? "bg-amber-500 text-zinc-950"
                  : "text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100"
              )}
            >
              <span className="text-sm font-semibold">
                {t.label}
                <span
                  className={cn(
                    "ml-1.5 rounded-full px-1.5 py-0.5 text-[11px]",
                    isActive ? "bg-zinc-950/15 text-zinc-900" : "bg-zinc-800 text-zinc-300"
                  )}
                >
                  {loading ? "…" : c.total}
                </span>
              </span>
              <span className={cn("mt-0.5 text-[11px]", isActive ? "text-zinc-900/70" : "text-zinc-500")}>
                {loading ? " " : `${c.monitored} monitored`}
              </span>
            </button>
          );
        })}
      </div>

      {/* Filters — scoped to the active tab */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
          Search
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Filter ${tab} by title…`}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Monitored
          <Select
            value={monitorFilter}
            onChange={(e) => setMonitorFilter(e.target.value as MonitorFilter)}
            className="w-full sm:w-44"
          >
            <option value="all">All</option>
            <option value="monitored">Monitored only</option>
            <option value="unmonitored">Unmonitored only</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Sort by
          <Select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="w-full sm:w-44"
          >
            <option value="title">Title (A–Z)</option>
            <option value="added">Recently added</option>
            <option value="imported">Recently imported</option>
          </Select>
        </label>
      </div>

      {/* Bulk / select-all bar — sticks below the header while the list scrolls */}
      <div className="sticky top-16 z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/90 px-3 py-2 backdrop-blur md:top-4">
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <Checkbox
            ref={setSelectAllRef}
            checked={allSelected}
            disabled={loading || filteredIds.length === 0}
            onChange={toggleSelectAll}
            aria-label="Select all shown"
          />
          <span>
            <span className="text-zinc-200">{loading ? "…" : filtered.length}</span> shown
            <span className="hidden sm:inline">
              {" "}
              · <span className="text-zinc-200">{active.monitored}</span>/{active.total} monitored
            </span>{" "}
            · <span className="text-zinc-200">{selected.size}</span> selected
          </span>
        </label>
        <div className="flex items-center gap-2">
          {/* Set monitor mode — series/anime only (movies have no monitor mode) */}
          {tab !== "movies" && (
            <div className="flex items-center gap-2">
              <span className="hidden text-xs text-zinc-500 sm:inline">Set mode</span>
              <div className="inline-flex overflow-hidden rounded-md border border-zinc-700">
                {MODES.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    disabled={selected.size === 0 || busy}
                    onClick={() => applyBulkMode([...selected], m.value)}
                    title={`Set selected series to monitor ${m.label.toLowerCase()} episodes`}
                    className={cn(
                      "px-2 py-1 text-[11px] font-medium text-zinc-400 transition-colors",
                      "hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-zinc-400"
                    )}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={selected.size === 0 || busy}
            loading={busy}
            onClick={() => applyBulk([...selected], true)}
          >
            Monitor
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={selected.size === 0 || busy}
            onClick={() => applyBulk([...selected], false)}
          >
            Unmonitor
          </Button>
          {selected.size > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Items — list rows or poster tiles, driven by the view toggle */}
      {loading ? (
        view === "tiles" ? (
          <div className={TILE_GRID}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
                <Skeleton className="aspect-[2/3] w-full" />
                <Skeleton className="mt-2 h-4 w-3/4" />
                <Skeleton className="mt-2 h-6 w-full" />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        )
      ) : filtered.length === 0 ? (
        <EmptyState
          title={`No ${tab} to show`}
          description={
            activeRows.length === 0
              ? `You have no ${tab} in your library yet.`
              : "No items match the current filters. Try adjusting the search or monitored filter."
          }
        />
      ) : view === "tiles" ? (
        /* ---- Tiles view: responsive poster grid ---- */
        <ul className={TILE_GRID}>
          {filtered.map((row) => {
            const isSelected = selected.has(row.id);
            const isSaving = savingIds.has(row.id);
            const poster = tmdbPoster(row.posterPath, "w342");
            const href = detailHref(row);
            return (
              <li
                key={row.id}
                className={cn(
                  "group relative flex flex-col overflow-hidden rounded-lg border transition-colors",
                  isSelected
                    ? "border-amber-500/60 bg-amber-500/5"
                    : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"
                )}
              >
                {/* Corner select checkbox — sibling of the link (not nested in the anchor). */}
                <label
                  className="absolute left-2 top-2 z-10 flex cursor-pointer items-center rounded bg-zinc-950/80 p-1 ring-1 ring-zinc-700 backdrop-blur"
                  title={`Select ${row.title}`}
                >
                  <Checkbox
                    checked={isSelected}
                    onChange={() => toggleRow(row.id)}
                    aria-label={`Select ${row.title}`}
                  />
                </label>

                {/* Drill-in link: poster + title */}
                <Link href={href} className="block focus:outline-none">
                  <div className="relative aspect-[2/3] w-full overflow-hidden bg-zinc-800">
                    {poster ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={poster}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center px-2 text-center text-xs text-zinc-600">
                        No art
                      </div>
                    )}
                    {/* Subtle "open" affordance on hover/focus */}
                    <span className="pointer-events-none absolute right-2 top-2 rounded bg-zinc-950/80 px-1.5 py-0.5 text-[11px] font-medium text-zinc-100 opacity-0 ring-1 ring-zinc-700 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      Open ↗
                    </span>
                  </div>
                  <div className="px-2 pt-2">
                    <div
                      className="truncate text-sm font-medium text-zinc-100 group-hover:text-amber-300"
                      title={row.title}
                    >
                      {row.title}
                    </div>
                    <div className="text-xs text-zinc-500">{row.year ?? "—"}</div>
                  </div>
                </Link>

                {/* Controls — outside the anchor so their clicks never navigate. */}
                <div className="mt-auto flex flex-col gap-2 px-2 pb-2 pt-2">
                  {row.apiType === "series" && (
                    <ModeButtons
                      fill
                      value={row.monitorMode ?? "all"}
                      disabled={isSaving || busy}
                      onSelect={(mode) => changeMode(row, mode)}
                    />
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-zinc-500">
                      {row.monitored ? "Monitored" : "Unmonitored"}
                    </span>
                    <MonitorToggle
                      checked={row.monitored}
                      pending={isSaving}
                      disabled={busy}
                      onChange={() => toggleMonitored(row)}
                      aria-label={`${row.monitored ? "Unmonitor" : "Monitor"} ${row.title}`}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        /* ---- List view: compact rows ---- */
        <ul className="space-y-2">
          {filtered.map((row) => {
            const isSelected = selected.has(row.id);
            const isSaving = savingIds.has(row.id);
            const poster = tmdbPoster(row.posterPath, "w92");
            const href = detailHref(row);
            return (
              <li
                key={row.id}
                className={cn(
                  "flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
                  isSelected
                    ? "border-amber-500/40 bg-amber-500/5"
                    : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900/70"
                )}
              >
                <Checkbox
                  checked={isSelected}
                  onChange={() => toggleRow(row.id)}
                  aria-label={`Select ${row.title}`}
                />

                {/* Drill-in link: poster + title (controls stay outside the anchor). */}
                <Link
                  href={href}
                  className="group flex min-w-0 flex-1 items-center gap-3 focus:outline-none"
                >
                  {poster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={poster}
                      alt=""
                      loading="lazy"
                      className="h-14 w-10 shrink-0 rounded object-cover ring-1 ring-zinc-800"
                    />
                  ) : (
                    <div className="flex h-14 w-10 shrink-0 items-center justify-center rounded bg-zinc-800 text-[9px] text-zinc-600 ring-1 ring-zinc-800">
                      No art
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1">
                      <span
                        className="truncate text-sm font-medium text-zinc-100 group-hover:text-amber-300"
                        title={row.title}
                      >
                        {row.title}
                      </span>
                      <span
                        aria-hidden
                        className="shrink-0 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                      >
                        ↗
                      </span>
                    </div>
                    {row.year != null && <div className="text-xs text-zinc-500">{row.year}</div>}
                  </div>
                </Link>

                <div className="flex items-center gap-2 sm:gap-3">
                  {row.apiType === "series" && (
                    <ModeButtons
                      value={row.monitorMode ?? "all"}
                      disabled={isSaving || busy}
                      onSelect={(mode) => changeMode(row, mode)}
                    />
                  )}

                  <MonitorToggle
                    checked={row.monitored}
                    pending={isSaving}
                    disabled={busy}
                    onChange={() => toggleMonitored(row)}
                    aria-label={`${row.monitored ? "Unmonitor" : "Monitor"} ${row.title}`}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
