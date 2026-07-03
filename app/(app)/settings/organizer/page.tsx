"use client";

import { useEffect, useMemo, useState } from "react";
import { ApiError, apiFetch, useApi } from "@/lib/api";
import { formatBytes, type MovieSummary, type SeriesSummary } from "@/lib/types";
import type { OrganizeItem } from "@/server/library/organizer-service";
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Input,
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
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [organized, setOrganized] = useState<Set<string>>(new Set());

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | FileCategory>("all");
  const [matchFilter, setMatchFilter] = useState<"all" | "matched" | "unmatched">("all");

  const { data: series } = useApi<SeriesSummary[]>("/series");
  const { data: movies } = useApi<MovieSummary[]>("/movies");

  async function runScan() {
    setScanning(true);
    setScan(null);
    setScanError(null);
    setOrganized(new Set());
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
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search filename or title…"
              className="max-w-xs"
            />
            <Select
              aria-label="Filter by type"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
              className="w-36"
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
              className="w-36"
            >
              <option value="all">Matched &amp; not</option>
              <option value="matched">Matched</option>
              <option value="unmatched">Unmatched</option>
            </Select>
          </div>

          {visible.length === 0 ? (
            <EmptyState title="No files match your filters" />
          ) : (
            <Table>
              <THead>
                <TR>
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
    </div>
  );
}

// ---------- one file row ----------

function FileRow({
  item,
  series,
  movies,
  done,
  onOrganized,
}: {
  item: OrganizeItem;
  series: SeriesSummary[];
  movies: MovieSummary[];
  done: boolean;
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
          <TD colSpan={6}>
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
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search source, title or episode…"
          className="max-w-xs"
        />
        <Select
          aria-label="Filter log by type"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
          className="w-36"
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
          className="w-36"
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
