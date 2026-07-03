"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch, ApiError, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { tmdbPoster, type LookupResult } from "@/lib/types";
import { cn } from "@/lib/cn";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Skeleton,
  useToast,
} from "@/components/ui";

type Status = "pending" | "approved" | "declined" | "available";
type SearchKind = "movie" | "series" | "anime";

interface RequestRow {
  id: number;
  mediaType: "series" | "movie";
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  status: Status;
  declineReason: string | null;
  createdAt: number | string;
  userId: number;
  username: string;
  movieId: number | null;
  seriesId: number | null;
}

interface Me {
  id: number;
  username: string;
  role: "admin" | "user";
}

const STATUS_META: Record<Status, { tone: "accent" | "info" | "success" | "danger"; label: string }> = {
  pending: { tone: "accent", label: "Pending" },
  approved: { tone: "info", label: "Approved" },
  available: { tone: "success", label: "Available" },
  declined: { tone: "danger", label: "Declined" },
};

const KIND_LABELS: Record<SearchKind, string> = {
  movie: "Movie",
  series: "Series",
  anime: "Anime",
};

const STATUS_ORDER: Status[] = ["pending", "approved", "available", "declined"];

export default function RequestsPage() {
  const { data: me } = useApi<Me>("/auth/me");
  const { data: requests, mutate } = useApi<RequestRow[]>("/requests");
  const [kind, setKind] = useState<SearchKind>("movie");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LookupResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [filter, setFilter] = useState<Status | "all">("all");
  const toast = useToast();
  useEvents();

  const isAdmin = me?.role === "admin";
  // Anime is stored as a series request — the schema only has movie/series.
  const requestMediaType = kind === "movie" ? "movie" : "series";

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    try {
      setResults(
        await apiFetch<LookupResult[]>(`/lookup?type=${kind}&q=${encodeURIComponent(query)}`)
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }

  async function requestItem(item: LookupResult) {
    try {
      await apiFetch("/requests", {
        method: "POST",
        body: JSON.stringify({
          mediaType: requestMediaType,
          tmdbId: item.tmdbId,
          title: item.title,
          year: item.year,
          posterPath:
            item.posterPath ?? (item.poster ? item.poster.replace(/^.*\/t\/p\/w\d+/, "") : null),
        }),
      });
      toast.success(`Requested “${item.title}” — waiting for approval.`);
      // Reflect the new state on the search card without a refetch.
      setResults((prev) =>
        prev?.map((r) =>
          r.tmdbId === item.tmdbId ? { ...r, status: "requested", requestedByMe: true } : r
        ) ?? prev
      );
      await mutate();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setResults((prev) =>
          prev?.map((r) => (r.tmdbId === item.tmdbId ? { ...r, requestedByMe: true } : r)) ?? prev
        );
        toast.info("You already requested this.");
      } else {
        toast.error(err instanceof Error ? err.message : "Request failed");
      }
    }
  }

  async function decide(id: number, action: "approve" | "decline") {
    setBusyId(id);
    try {
      await apiFetch(`/requests/${id}`, { method: "PUT", body: JSON.stringify({ action }) });
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(id: number) {
    setBusyId(id);
    try {
      await apiFetch(`/requests/${id}`, { method: "DELETE" });
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setBusyId(null);
    }
  }

  const counts = useMemo(() => {
    const c: Record<Status, number> = { pending: 0, approved: 0, available: 0, declined: 0 };
    for (const r of requests ?? []) c[r.status]++;
    return c;
  }, [requests]);

  const activeStatuses = STATUS_ORDER.filter((s) => counts[s] > 0);

  const filtered = useMemo(
    () => (requests ?? []).filter((r) => filter === "all" || r.status === filter),
    [requests, filter]
  );

  return (
    <div className="mx-auto max-w-5xl">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{isAdmin ? "Requests" : "My List"}</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {isAdmin
              ? "Review what your users have asked for and approve or decline."
              : "Search for a movie, series or anime and track your requests here."}
          </p>
        </div>
        {requests && requests.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {activeStatuses.map((s) => (
              <Badge key={s} tone={STATUS_META[s].tone}>
                {counts[s]} {STATUS_META[s].label}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Search / request */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Request something new</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="inline-flex shrink-0 rounded-lg border border-zinc-800 bg-zinc-900 p-1">
              {(Object.keys(KIND_LABELS) as SearchKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setKind(k);
                    setResults(null);
                  }}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    kind === k ? "bg-amber-500 text-zinc-950" : "text-zinc-400 hover:text-zinc-200"
                  )}
                >
                  {KIND_LABELS[k]}
                </button>
              ))}
            </div>
            <div className="flex flex-1 gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && search()}
                placeholder={`Search ${KIND_LABELS[kind].toLowerCase()}s on TMDB…`}
                className="flex-1"
              />
              <Button type="button" onClick={search} loading={searching}>
                Search
              </Button>
            </div>
          </div>

          {searching && !results && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="aspect-[2/3] w-full rounded-lg" />
              ))}
            </div>
          )}

          {results && results.length === 0 && (
            <p className="py-6 text-center text-sm text-zinc-500">
              No results for “{query}”. Try a different title.
            </p>
          )}

          {results && results.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {results.slice(0, 15).map((r) => (
                <SearchResultCard key={r.tmdbId} item={r} onRequest={() => requestItem(r)} />
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Request list */}
      <section className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{isAdmin ? "All requests" : "My requests"}</h2>
          {requests && requests.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <FilterPill active={filter === "all"} onClick={() => setFilter("all")}>
                All {requests.length}
              </FilterPill>
              {activeStatuses.map((s) => (
                <FilterPill key={s} active={filter === s} onClick={() => setFilter(s)}>
                  {STATUS_META[s].label} {counts[s]}
                </FilterPill>
              ))}
            </div>
          )}
        </div>

        {!requests ? (
          <div className="mt-4 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        ) : requests.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={<span className="text-3xl">🎬</span>}
            title="No requests yet"
            description="Search for a movie, series or anime above to make your first request."
          />
        ) : filtered.length === 0 ? (
          <p className="mt-4 py-8 text-center text-sm text-zinc-500">
            No {STATUS_META[filter as Status]?.label.toLowerCase()} requests.
          </p>
        ) : (
          <div className="mt-4 space-y-2">
            {filtered.map((r) => (
              <RequestListItem
                key={r.id}
                row={r}
                isAdmin={!!isAdmin}
                busy={busyId === r.id}
                onApprove={() => decide(r.id, "approve")}
                onDecline={() => decide(r.id, "decline")}
                onCancel={() => cancel(r.id)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** One search hit: poster, availability overlay, and the right request action. */
function SearchResultCard({
  item,
  onRequest,
}: {
  item: LookupResult;
  onRequest: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const status = item.status ?? "unavailable";
  const requestedByMe = item.requestedByMe ?? false;

  const overlay: { tone: "success" | "accent" | "info"; label: string } | null =
    status === "available"
      ? { tone: "success", label: "Available" }
      : requestedByMe
        ? { tone: "accent", label: "Requested" }
        : status === "requested"
          ? { tone: "info", label: "Already requested" }
          : null;

  async function handle() {
    setBusy(true);
    try {
      await onRequest();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div className="relative aspect-[2/3] w-full bg-zinc-800">
        {item.poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.poster} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-2 text-center text-xs text-zinc-500">
            {item.title}
          </div>
        )}
        {overlay && (
          <Badge tone={overlay.tone} className="absolute left-1.5 top-1.5 shadow-sm">
            {overlay.label}
          </Badge>
        )}
      </div>
      <div className="p-2">
        <div className="truncate text-xs font-medium" title={item.title}>
          {item.title}
        </div>
        <div className="text-[11px] text-zinc-500">{item.year ?? "—"}</div>
        <div className="mt-2">
          {status === "available" ? (
            <Button size="sm" variant="outline" disabled className="w-full justify-center">
              In library
            </Button>
          ) : requestedByMe ? (
            <Button size="sm" variant="secondary" disabled className="w-full justify-center">
              Requested
            </Button>
          ) : status === "requested" ? (
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={handle}
              className="w-full justify-center"
              title="Already requested by someone else — add it to your list too"
            >
              Also request
            </Button>
          ) : (
            <Button
              size="sm"
              loading={busy}
              onClick={handle}
              className="w-full justify-center"
            >
              Request
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A single row in the request list — poster thumb, meta, status and actions. */
function RequestListItem({
  row,
  isAdmin,
  busy,
  onApprove,
  onDecline,
  onCancel,
}: {
  row: RequestRow;
  isAdmin: boolean;
  busy: boolean;
  onApprove: () => void;
  onDecline: () => void;
  onCancel: () => void;
}) {
  const poster = tmdbPoster(row.posterPath, "w154");
  const href =
    row.status === "available"
      ? row.mediaType === "movie" && row.movieId != null
        ? `/movies/${row.movieId}`
        : row.mediaType === "series" && row.seriesId != null
          ? `/series/${row.seriesId}`
          : null
      : null;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="h-16 w-11 shrink-0 overflow-hidden rounded bg-zinc-800">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">
          {row.title}{" "}
          {row.year ? <span className="font-normal text-zinc-500">({row.year})</span> : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
          <span className="capitalize">{row.mediaType}</span>
          <span aria-hidden>·</span>
          <span>{new Date(row.createdAt).toLocaleDateString()}</span>
          {isAdmin && (
            <>
              <span aria-hidden>·</span>
              <span className="text-zinc-400">{row.username}</span>
            </>
          )}
        </div>
        {row.status === "declined" && row.declineReason && (
          <p className="mt-1 text-xs text-red-400">Declined: {row.declineReason}</p>
        )}
      </div>

      <Badge tone={STATUS_META[row.status].tone} className="shrink-0">
        {STATUS_META[row.status].label}
      </Badge>

      <div className="flex shrink-0 gap-2">
        {href && (
          <Link
            href={href}
            className="inline-flex h-8 items-center rounded-md border border-zinc-700 px-3 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
          >
            {row.mediaType === "movie" ? "Watch" : "View"}
          </Link>
        )}
        {isAdmin && row.status === "pending" && (
          <>
            <Button size="sm" loading={busy} onClick={onApprove}>
              Approve
            </Button>
            <Button size="sm" variant="danger" loading={busy} onClick={onDecline}>
              Decline
            </Button>
          </>
        )}
        {!isAdmin && row.status === "pending" && (
          <Button size="sm" variant="secondary" loading={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-amber-500/40 bg-amber-500/15 text-amber-200"
          : "border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:text-zinc-200"
      )}
    >
      {children}
    </button>
  );
}
