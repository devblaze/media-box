"use client";

import { useState, type ComponentProps } from "react";
import Link from "next/link";
import { apiFetch, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { tmdbPoster, timeAgo, type LookupResult } from "@/lib/types";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Skeleton,
  useToast,
} from "@/components/ui";
import { cn } from "@/lib/cn";

/**
 * Refined lifecycle stage shown as the status badge — the server folds the live
 * download state into the stored `status` for approved requests. See the
 * `GET /requests` route for the derivation.
 */
type RequestStage =
  | "pending"
  | "searching"
  | "queued"
  | "downloading"
  | "importing"
  | "available"
  | "failed"
  | "declined";

interface RequestRow {
  id: number;
  mediaType: "series" | "movie";
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  status: "pending" | "approved" | "declined" | "available";
  /** Display stage refining `status` with live download progress. */
  stage: RequestStage;
  /** Extra context for the badge tooltip (decline reason / download error). */
  stageDetail: string | null;
  declineReason: string | null;
  createdAt: number | string;
  userId: number;
  username: string;
}

interface Me {
  id: number;
  username: string;
  role: "admin" | "user";
}

type Kind = "movie" | "series" | "anime";

const KINDS: { value: Kind; label: string }[] = [
  { value: "movie", label: "Movie" },
  { value: "series", label: "Series" },
  { value: "anime", label: "Anime" },
];

/** Anime is a series in the library; the request/detail routes use "series". */
function mediaTypeOf(kind: Kind): "movie" | "series" {
  return kind === "movie" ? "movie" : "series";
}

/** Badge label + colour for each refined request stage. */
const STAGE_META: Record<
  RequestStage,
  { label: string; tone: ComponentProps<typeof Badge>["tone"] }
> = {
  pending: { label: "Pending", tone: "accent" },
  searching: { label: "Searching", tone: "info" },
  queued: { label: "Queued", tone: "info" },
  downloading: { label: "Downloading", tone: "info" },
  importing: { label: "Importing", tone: "info" },
  available: { label: "Available", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  declined: { label: "Declined", tone: "danger" },
};

function toMillis(value: number | string): number {
  return typeof value === "number" ? value : Date.parse(value);
}

export default function RequestsPage() {
  const { data: me } = useApi<Me>("/auth/me");
  const { data: requests, mutate } = useApi<RequestRow[]>("/requests");
  const [kind, setKind] = useState<Kind>("movie");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LookupResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const toast = useToast();
  useEvents();

  const isAdmin = me?.role === "admin";
  const mediaType = mediaTypeOf(kind);

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

  /** Patch a single result's availability status in place. */
  function setResultStatus(tmdbId: number, status: LookupResult["status"]) {
    setResults((prev) =>
      prev ? prev.map((r) => (r.tmdbId === tmdbId ? { ...r, status } : r)) : prev
    );
  }

  async function requestItem(item: LookupResult) {
    // Optimistically flip the card to "Requested" for instant feedback.
    setResultStatus(item.tmdbId, "requested");
    try {
      const created = await apiFetch<{ status: RequestRow["status"] }>("/requests", {
        method: "POST",
        body: JSON.stringify({
          mediaType,
          tmdbId: item.tmdbId,
          title: item.title,
          year: item.year,
          posterPath: item.posterPath ?? null,
        }),
      });
      toast.success(
        created.status === "pending"
          ? `Requested "${item.title}" — waiting for approval.`
          : `"${item.title}" is being added to your library.`
      );
      await mutate();
    } catch (err) {
      setResultStatus(item.tmdbId, "unavailable"); // revert on failure
      toast.error(err instanceof Error ? err.message : "Request failed");
    }
  }

  async function decide(id: number, action: "approve" | "decline") {
    try {
      await apiFetch(`/requests/${id}`, { method: "PUT", body: JSON.stringify({ action }) });
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${action} failed`);
    }
  }

  async function cancel(id: number) {
    try {
      await apiFetch(`/requests/${id}`, { method: "DELETE" });
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    }
  }

  return (
    <div className="px-4 py-6 md:px-12">
      <h1 className="text-2xl font-semibold tracking-tight">My List</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Search for something to add, and track what you&rsquo;ve requested.
      </p>

      {/* ── Search ─────────────────────────────────────────────── */}
      <section className="mt-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="inline-flex shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 p-0.5">
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                onClick={() => {
                  setKind(k.value);
                  setResults(null);
                }}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  kind === k.value
                    ? "bg-amber-500 text-zinc-950"
                    : "text-zinc-400 hover:text-zinc-100"
                )}
              >
                {k.label}
              </button>
            ))}
          </div>
          <div className="flex flex-1 gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              placeholder={`Search for a ${kind}…`}
              className="flex-1"
            />
            <Button type="button" onClick={search} loading={searching}>
              Search
            </Button>
          </div>
        </div>

        {results && results.length === 0 && !searching && (
          <p className="mt-6 text-sm text-zinc-500">
            No matches for &ldquo;{query}&rdquo;. Try a different title.
          </p>
        )}

        {results && results.length > 0 && (
          <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {results.map((r) => {
              const detailHref =
                r.status === "available" && r.mediaId != null
                  ? `/${mediaType}s/${r.mediaId}`
                  : null;

              const poster = r.poster ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={r.poster}
                  alt=""
                  loading="lazy"
                  className="aspect-[2/3] w-full rounded-lg object-cover"
                />
              ) : (
                <div className="flex aspect-[2/3] w-full items-center justify-center rounded-lg bg-zinc-800 text-xs text-zinc-600">
                  No poster
                </div>
              );

              const meta = (
                <div className="mt-2 min-w-0">
                  <div className="truncate text-sm font-medium text-zinc-100">{r.title}</div>
                  <div className="text-xs text-zinc-500">{r.year ?? "—"}</div>
                </div>
              );

              // available + in library → whole card links to the detail page
              if (detailHref) {
                return (
                  <Link
                    key={r.tmdbId}
                    href={detailHref}
                    className="group block rounded-xl border border-zinc-800 bg-zinc-900/40 p-2 transition-colors hover:border-emerald-500/60"
                  >
                    <div className="relative">
                      {poster}
                      <span className="absolute inset-x-0 bottom-0 rounded-b-lg bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-6 text-xs font-medium text-emerald-300">
                        In library
                      </span>
                    </div>
                    {meta}
                  </Link>
                );
              }

              return (
                <div
                  key={r.tmdbId}
                  className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/40 p-2"
                >
                  {poster}
                  {meta}
                  <div className="mt-2">
                    {r.status === "available" ? (
                      <div className="flex h-8 items-center justify-center rounded-md bg-emerald-500/10 text-xs font-medium text-emerald-300">
                        In library
                      </div>
                    ) : r.status === "requested" ? (
                      <div
                        className="flex h-8 cursor-default items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-xs font-medium text-zinc-500"
                        aria-disabled="true"
                      >
                        Requested
                      </div>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        className="w-full justify-center"
                        onClick={() => requestItem(r)}
                      >
                        Request
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Requests list ──────────────────────────────────────── */}
      <section className="mt-10">
        <h2 className="text-lg font-semibold">{isAdmin ? "All requests" : "My requests"}</h2>

        {!requests ? (
          <div className="mt-3 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5"
              >
                <Skeleton className="h-16 w-11 shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-1/5" />
                </div>
                <Skeleton className="h-6 w-20" />
              </div>
            ))}
          </div>
        ) : requests.length === 0 ? (
          <EmptyState
            className="mt-3"
            title="No requests yet"
            description="Search for a movie, series, or anime above to make your first request."
          />
        ) : (
          <ul className="mt-3 divide-y divide-zinc-800 overflow-hidden rounded-lg border border-zinc-800">
            {requests.map((r) => {
              const poster = tmdbPoster(r.posterPath) ?? r.posterPath;
              const canCancel =
                r.status === "pending" && !isAdmin && (me == null || r.userId === me.id);
              return (
                <li
                  key={r.id}
                  className="flex items-center gap-3 bg-zinc-900/40 px-3 py-2.5 hover:bg-zinc-900/70"
                >
                  {poster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={poster}
                      alt=""
                      loading="lazy"
                      className="aspect-[2/3] w-11 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <div className="aspect-[2/3] w-11 shrink-0 rounded-md bg-zinc-800" />
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-zinc-100">
                      {r.title}
                      {r.year ? <span className="ml-1 text-zinc-500">({r.year})</span> : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
                      <span className="capitalize">{r.mediaType}</span>
                      <span aria-hidden>·</span>
                      <span>{timeAgo(toMillis(r.createdAt))}</span>
                      {isAdmin && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="text-zinc-400">{r.username}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {(() => {
                    const meta = STAGE_META[r.stage] ?? STAGE_META.pending;
                    return (
                      <Badge
                        tone={meta.tone}
                        className="shrink-0"
                        title={r.stageDetail ?? undefined}
                      >
                        {meta.label}
                      </Badge>
                    );
                  })()}

                  <div className="flex shrink-0 items-center gap-2">
                    {isAdmin && r.status === "pending" && (
                      <>
                        <Button size="sm" onClick={() => decide(r.id, "approve")}>
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => decide(r.id, "decline")}
                        >
                          Decline
                        </Button>
                      </>
                    )}
                    {canCancel && (
                      <Button size="sm" variant="secondary" onClick={() => cancel(r.id)}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
