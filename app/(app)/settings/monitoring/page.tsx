"use client";

import { useMemo, useRef, useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import type { MovieSummary, SeriesSummary } from "@/lib/types";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Input,
  Select,
  Skeleton,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  useToast,
} from "@/components/ui";

type ApiType = "movie" | "series";
type Kind = "movie" | "series" | "anime";
type MonitorMode = "all" | "future" | "none";

interface UnifiedItem {
  key: string;
  type: ApiType;
  kind: Kind;
  id: number;
  title: string;
  year: number | null;
  monitored: boolean;
  monitorMode?: MonitorMode;
}

type TypeFilter = "all" | "movie" | "series" | "anime";
type MonitorFilter = "all" | "monitored" | "unmonitored";

const KIND_LABEL: Record<Kind, string> = { movie: "Movie", series: "Series", anime: "Anime" };
const KIND_TONE: Record<Kind, "info" | "neutral" | "accent"> = {
  movie: "info",
  series: "neutral",
  anime: "accent",
};

export default function MonitoringPage() {
  const { data: series, mutate: mutateSeries } = useApi<SeriesSummary[]>("/series");
  const { data: movies, mutate: mutateMovies } = useApi<MovieSummary[]>("/movies");
  const toast = useToast();

  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [monitorFilter, setMonitorFilter] = useState<MonitorFilter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const loading = series === undefined || movies === undefined;

  const all: UnifiedItem[] = useMemo(() => {
    const s: UnifiedItem[] = (series ?? []).map((r) => ({
      key: `series-${r.id}`,
      type: "series",
      kind: r.isAnime ? "anime" : "series",
      id: r.id,
      title: r.title,
      year: r.year,
      monitored: r.monitored,
      monitorMode: r.monitorMode,
    }));
    const m: UnifiedItem[] = (movies ?? []).map((r) => ({
      key: `movie-${r.id}`,
      type: "movie",
      kind: "movie",
      id: r.id,
      title: r.title,
      year: r.year,
      monitored: r.monitored,
    }));
    return [...s, ...m].sort((a, b) => a.title.localeCompare(b.title));
  }, [series, movies]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((it) => {
      if (typeFilter !== "all" && it.kind !== typeFilter) return false;
      if (monitorFilter === "monitored" && !it.monitored) return false;
      if (monitorFilter === "unmonitored" && it.monitored) return false;
      if (q && !it.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [all, typeFilter, monitorFilter, search]);

  const filteredKeys = useMemo(() => filtered.map((it) => it.key), [filtered]);
  const allFilteredSelected =
    filteredKeys.length > 0 && filteredKeys.every((k) => selected.has(k));
  const someFilteredSelected = !allFilteredSelected && filteredKeys.some((k) => selected.has(k));

  const selectAllRef = useRef<HTMLInputElement>(null);
  const setSelectAllRef = (el: HTMLInputElement | null) => {
    selectAllRef.current = el;
    if (el) el.indeterminate = someFilteredSelected;
  };

  function toggleRow(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSelectAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filteredKeys.forEach((k) => next.delete(k));
      else filteredKeys.forEach((k) => next.add(k));
      return next;
    });
  }

  const byKey = useMemo(() => new Map(all.map((it) => [it.key, it])), [all]);

  async function applyBulk(keys: string[], monitored: boolean) {
    const items = keys
      .map((k) => byKey.get(k))
      .filter((it): it is UnifiedItem => Boolean(it))
      .map((it) => ({ type: it.type, id: it.id, monitored }));
    if (items.length === 0) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ updated: number }>("/monitoring/bulk", {
        method: "POST",
        body: JSON.stringify({ items }),
      });
      await Promise.all([mutateSeries(), mutateMovies()]);
      toast.success(
        `${monitored ? "Monitoring" : "Unmonitored"} ${res.updated} item${res.updated === 1 ? "" : "s"}`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk update failed");
    } finally {
      setBusy(false);
    }
  }

  async function quickToggle(item: UnifiedItem) {
    setSavingKey(item.key);
    try {
      await apiFetch("/monitoring/bulk", {
        method: "POST",
        body: JSON.stringify({
          items: [{ type: item.type, id: item.id, monitored: !item.monitored }],
        }),
      });
      await (item.type === "series" ? mutateSeries() : mutateMovies());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSavingKey(null);
    }
  }

  async function changeMonitorMode(item: UnifiedItem, mode: MonitorMode) {
    setSavingKey(item.key);
    try {
      await apiFetch(`/series/${item.id}`, {
        method: "PUT",
        body: JSON.stringify({ monitorMode: mode }),
      });
      await mutateSeries();
      toast.success(`Monitor mode set to ${mode}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSavingKey(null);
    }
  }

  const selectedCount = selected.size;
  const monitoredCount = all.filter((it) => it.monitored).length;

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Monitoring</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Review and bulk-manage which media media-box is monitoring. Monitored items are searched
          and grabbed automatically.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Type
          <Select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
            className="w-full sm:w-40"
          >
            <option value="all">All</option>
            <option value="movie">Movies</option>
            <option value="series">Series</option>
            <option value="anime">Anime</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Monitored
          <Select
            value={monitorFilter}
            onChange={(e) => setMonitorFilter(e.target.value as MonitorFilter)}
            className="w-full sm:w-40"
          >
            <option value="all">All</option>
            <option value="monitored">Monitored</option>
            <option value="unmonitored">Unmonitored</option>
          </Select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
          Search
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by title…"
          />
        </label>
      </div>

      {/* Bulk action bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-2">
        <div className="text-sm text-zinc-400">
          {loading ? (
            "Loading…"
          ) : (
            <>
              <span className="text-zinc-200">{filtered.length}</span> shown ·{" "}
              <span className="text-zinc-200">{monitoredCount}</span>/{all.length} monitored ·{" "}
              <span className="text-zinc-200">{selectedCount}</span> selected
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={selectedCount === 0 || busy}
            loading={busy}
            onClick={() => applyBulk([...selected], true)}
          >
            Monitor
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={selectedCount === 0 || busy}
            onClick={() => applyBulk([...selected], false)}
          >
            Unmonitor
          </Button>
          {selectedCount > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="Nothing to show"
          description="No media matches the current filters. Add movies or series, or adjust the filters above."
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH className="w-10">
                <Checkbox
                  ref={setSelectAllRef}
                  checked={allFilteredSelected}
                  onChange={toggleSelectAllFiltered}
                  aria-label="Select all filtered"
                />
              </TH>
              <TH>Title</TH>
              <TH className="w-24">Type</TH>
              <TH className="w-28 text-center">Monitored</TH>
              <TH className="w-40">Monitor mode</TH>
            </TR>
          </THead>
          <TBody>
            {filtered.map((it) => {
              const isSaving = savingKey === it.key;
              return (
                <TR key={it.key} className={selected.has(it.key) ? "bg-amber-500/5" : undefined}>
                  <TD>
                    <Checkbox
                      checked={selected.has(it.key)}
                      onChange={() => toggleRow(it.key)}
                      aria-label={`Select ${it.title}`}
                    />
                  </TD>
                  <TD className="text-zinc-100">
                    {it.title}
                    {it.year ? <span className="text-zinc-500"> ({it.year})</span> : null}
                  </TD>
                  <TD>
                    <Badge tone={KIND_TONE[it.kind]}>{KIND_LABEL[it.kind]}</Badge>
                  </TD>
                  <TD className="text-center">
                    <button
                      type="button"
                      onClick={() => quickToggle(it)}
                      disabled={isSaving || busy}
                      title={it.monitored ? "Click to unmonitor" : "Click to monitor"}
                      className="inline-flex items-center justify-center rounded px-2 py-0.5 text-base disabled:opacity-50"
                    >
                      {it.monitored ? (
                        <span className="text-emerald-400">✓</span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </button>
                  </TD>
                  <TD>
                    {it.type === "series" ? (
                      <Select
                        value={it.monitorMode ?? "all"}
                        disabled={isSaving || busy}
                        onChange={(e) => changeMonitorMode(it, e.target.value as MonitorMode)}
                        className="h-8 py-0 text-xs"
                      >
                        <option value="all">All episodes</option>
                        <option value="future">Future only</option>
                        <option value="none">None</option>
                      </Select>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </div>
  );
}
