"use client";

import { useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import type { LookupResult } from "@/lib/types";
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
  Table,
  TBody,
  TD,
  TR,
  useToast,
} from "@/components/ui";

interface RequestRow {
  id: number;
  mediaType: "series" | "movie";
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  status: "pending" | "approved" | "declined" | "available";
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

const STATUS_TONE: Record<RequestRow["status"], "accent" | "info" | "success" | "danger"> = {
  pending: "accent",
  approved: "info",
  available: "success",
  declined: "danger",
};

export default function RequestsPage() {
  const { data: me } = useApi<Me>("/auth/me");
  const { data: requests, mutate } = useApi<RequestRow[]>("/requests");
  const [mediaType, setMediaType] = useState<"series" | "movie">("movie");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LookupResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const toast = useToast();
  useEvents();

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    try {
      setResults(
        await apiFetch<LookupResult[]>(`/lookup?type=${mediaType}&q=${encodeURIComponent(query)}`)
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
          mediaType,
          tmdbId: item.tmdbId,
          title: item.title,
          year: item.year,
          posterPath: item.poster ? item.poster.replace(/^.*\/t\/p\/w\d+/, "") : null,
        }),
      });
      toast.success(`Requested "${item.title}" — waiting for approval.`);
      await mutate();
    } catch (err) {
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

  const isAdmin = me?.role === "admin";

  return (
    <div className="max-w-4xl">
      <h1 className="text-xl font-semibold">Requests</h1>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Request something new</CardTitle>
        </CardHeader>
        <CardBody>
          <div className="flex gap-2">
            <div className="flex gap-1">
              {(["movie", "series"] as const).map((t) => (
                <Button
                  key={t}
                  type="button"
                  variant={mediaType === t ? "primary" : "outline"}
                  className="capitalize"
                  onClick={() => {
                    setMediaType(t);
                    setResults(null);
                  }}
                >
                  {t === "movie" ? "Movie" : "Series"}
                </Button>
              ))}
            </div>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              placeholder="Search TMDB…"
              className="flex-1"
            />
            <Button type="button" onClick={search} loading={searching}>
              Search
            </Button>
          </div>

          {results && (
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              {results.slice(0, 8).map((r) => (
                <div key={r.tmdbId} className="rounded border border-zinc-800 bg-zinc-900/50 p-2">
                  {r.poster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.poster} alt="" className="aspect-[2/3] w-full rounded object-cover" />
                  ) : (
                    <div className="aspect-[2/3] w-full rounded bg-zinc-800" />
                  )}
                  <div className="mt-1 truncate text-xs font-medium">
                    {r.title} {r.year ? `(${r.year})` : ""}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="mt-1.5 w-full justify-center"
                    onClick={() => requestItem(r)}
                  >
                    Request
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <section className="mt-6">
        <h2 className="font-medium">{isAdmin ? "All requests" : "My requests"}</h2>
        {!requests ? (
          <div className="mt-2 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : requests.length === 0 ? (
          <EmptyState
            className="mt-2"
            title="No requests yet."
            description="Search for a movie or series above to make your first request."
          />
        ) : (
          <Table className="mt-2">
            <TBody>
              {requests.map((r) => (
                <TR key={r.id}>
                  <TD>
                    {r.title} {r.year ? <span className="text-zinc-500">({r.year})</span> : null}
                    <span className="ml-2 text-xs text-zinc-500">{r.mediaType}</span>
                  </TD>
                  {isAdmin && <TD className="text-xs text-zinc-400">{r.username}</TD>}
                  <TD className="w-28">
                    <Badge tone={STATUS_TONE[r.status]} className="capitalize" title={r.declineReason ?? ""}>
                      {r.status}
                    </Badge>
                  </TD>
                  <TD className="w-28 text-xs text-zinc-500">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </TD>
                  <TD className="text-right whitespace-nowrap">
                    {isAdmin && r.status === "pending" && (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" onClick={() => decide(r.id, "approve")}>
                          Approve
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => decide(r.id, "decline")}>
                          Decline
                        </Button>
                      </div>
                    )}
                    {r.status === "pending" && !isAdmin && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={async () => {
                          await apiFetch(`/requests/${r.id}`, { method: "DELETE" });
                          await mutate();
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  );
}
