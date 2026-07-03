"use client";

import { useMemo, useState } from "react";
import { ApiError, apiFetch, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { tmdbPoster } from "@/lib/types";
import { ReleaseSearchDrawer, type SearchScope } from "@/components/release-search";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Select,
  Skeleton,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  useToast,
} from "@/components/ui";

type Status = "pending" | "approved" | "declined" | "available";
type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

interface RequestRow {
  id: number;
  mediaType: "series" | "movie";
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  seasons: number[] | null;
  status: Status;
  declineReason: string | null;
  createdAt: number | string;
  userId: number;
  username: string;
  movieId: number | null;
  seriesId: number | null;
}

interface QualityDefinition {
  id: number;
  name: string;
}

const STATUS_TONE: Record<Status, BadgeTone> = {
  pending: "accent",
  approved: "info",
  available: "success",
  declined: "danger",
};

const STATUS_FILTERS = ["all", "pending", "approved", "available", "declined"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/**
 * The library scope for an interactive release search, or null when the request
 * has not been added to the library yet (so no target exists). Movies target the
 * movie directly; the season-scoped indexer search targets the first requested
 * season (or season 1 when all seasons were requested).
 */
function searchScopeFor(r: RequestRow): { scope: SearchScope; label: string } | null {
  const label = `${r.title}${r.year ? ` (${r.year})` : ""}`;
  if (r.mediaType === "movie" && r.movieId != null) {
    return { scope: { movieId: r.movieId }, label };
  }
  if (r.mediaType === "series" && r.seriesId != null) {
    const season = r.seasons && r.seasons.length > 0 ? r.seasons[0] : 1;
    return { scope: { seriesId: r.seriesId, season }, label: `${label} — Season ${season}` };
  }
  return null;
}

export default function AdminRequestsPage() {
  const { data: requests, mutate } = useApi<RequestRow[]>("/requests");
  const { data: qualityDefs } = useApi<QualityDefinition[]>("/qualitydefinitions");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ scope: SearchScope; label: string } | null>(null);
  const [deciding, setDeciding] = useState<number | null>(null);
  const toast = useToast();
  useEvents();

  const qualityNames = useMemo(
    () => new Map((qualityDefs ?? []).map((q) => [q.id, q.name])),
    [qualityDefs]
  );

  const filtered = useMemo(() => {
    if (!requests) return null;
    const q = query.trim().toLowerCase();
    return requests.filter(
      (r) =>
        (status === "all" || r.status === status) &&
        (q === "" || r.title.toLowerCase().includes(q))
    );
  }, [requests, status, query]);

  async function decide(id: number, action: "approve" | "decline") {
    setDeciding(id);
    try {
      await apiFetch(`/requests/${id}`, { method: "PUT", body: JSON.stringify({ action }) });
      await mutate();
      toast.success(action === "approve" ? "Request approved" : "Request declined");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : `${action} failed`);
    } finally {
      setDeciding(null);
    }
  }

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Requests</h1>
        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title…"
            className="w-48"
            aria-label="Search by title"
          />
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            className="w-36"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="available">Available</option>
            <option value="declined">Declined</option>
          </Select>
        </div>
      </div>

      <p className="text-sm text-zinc-400">
        Every request across all users. Approve a pending request to add it to the library, then run
        an interactive search to grab a release the automatic search missed.
      </p>

      {!filtered ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No matching requests"
          description={
            requests && requests.length > 0
              ? "Try a different status or search term."
              : "Requests made by users will appear here."
          }
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Title</TH>
              <TH className="w-32">Requested by</TH>
              <TH className="w-24">Type</TH>
              <TH className="w-28">Status</TH>
              <TH className="w-28">Requested</TH>
              <TH className="w-48 text-right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {filtered.map((r) => {
              const poster = tmdbPoster(r.posterPath, "w92");
              const target = searchScopeFor(r);
              return (
                <TR key={r.id} className="align-middle">
                  <TD>
                    <div className="flex items-center gap-3">
                      {poster ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={poster}
                          alt=""
                          className="h-14 w-10 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <div className="h-14 w-10 shrink-0 rounded bg-zinc-800" />
                      )}
                      <div className="min-w-0">
                        <div className="truncate font-medium text-zinc-100">{r.title}</div>
                        {r.year ? <div className="text-xs text-zinc-500">{r.year}</div> : null}
                      </div>
                    </div>
                  </TD>
                  <TD className="text-zinc-300">{r.username}</TD>
                  <TD>
                    <Badge tone="neutral">{r.mediaType === "movie" ? "Movie" : "Series"}</Badge>
                  </TD>
                  <TD>
                    <Badge
                      tone={STATUS_TONE[r.status]}
                      className="capitalize"
                      title={r.declineReason ?? undefined}
                    >
                      {r.status}
                    </Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-zinc-500">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </TD>
                  <TD className="text-right whitespace-nowrap">
                    <div className="flex justify-end gap-2">
                      {r.status === "pending" ? (
                        <>
                          <Button
                            size="sm"
                            loading={deciding === r.id}
                            disabled={deciding !== null}
                            onClick={() => decide(r.id, "approve")}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={deciding !== null}
                            onClick={() => decide(r.id, "decline")}
                          >
                            Decline
                          </Button>
                        </>
                      ) : target ? (
                        <Button size="sm" variant="secondary" onClick={() => setSearch(target)}>
                          Interactive search
                        </Button>
                      ) : (
                        <span className="text-xs text-zinc-600">—</span>
                      )}
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      {search && (
        <ReleaseSearchDrawer
          scope={search.scope}
          title={search.label}
          qualityNames={qualityNames}
          onClose={() => setSearch(null)}
        />
      )}
    </div>
  );
}
