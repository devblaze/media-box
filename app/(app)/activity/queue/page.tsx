"use client";

import Link from "next/link";
import { apiFetch, useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import { formatBytes } from "@/lib/types";
import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from "@/components/ui";

interface QueueItem {
  id: number;
  title: string;
  status: string;
  statusMessage: string | null;
  mediaType: "series" | "movie";
  seriesId: number | null;
  movieId: number | null;
  size: number | null;
  sizeLeft: number | null;
  grabbedAt: number | string;
  clientName: string | null;
  clientType: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  downloading: "Downloading",
  remoteCompleted: "Completed (remote)",
  fetching: "Fetching from TorBox",
  importPending: "Waiting to import",
  importing: "Importing",
  warning: "Needs attention",
  failed: "Failed",
};

function statusTone(status: string): "danger" | "success" | "neutral" {
  if (status === "failed" || status === "warning") return "danger";
  if (status === "importPending" || status === "importing") return "success";
  return "neutral";
}

export default function QueuePage() {
  const { data, mutate } = useApi<QueueItem[]>("/queue");
  const toast = useToast();
  useEvents();

  async function retry(id: number) {
    try {
      await apiFetch(`/queue/${id}`, { method: "POST" });
      await mutate();
      toast.success("Retrying import…");
    } catch {
      toast.error("Failed to retry import.");
    }
  }

  async function remove(id: number, blocklist: boolean) {
    try {
      await apiFetch(`/queue/${id}?blocklist=${blocklist}&removeFromClient=true`, {
        method: "DELETE",
      });
      await mutate();
      toast.success(blocklist ? "Removed and blocklisted." : "Removed from queue.");
    } catch {
      toast.error("Failed to remove from queue.");
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold">Queue</h1>
      {!data ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : data.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={<span className="text-3xl">📭</span>}
            title="Nothing in the queue."
            description="Grabbed releases will appear here while they download and import."
          />
        </div>
      ) : (
        <Table className="mt-4">
          <THead>
            <TR>
              <TH className="font-normal">Release</TH>
              <TH className="font-normal">Client</TH>
              <TH className="font-normal">Progress</TH>
              <TH className="font-normal">Status</TH>
              <TH className="font-normal" />
            </TR>
          </THead>
          <TBody>
            {data.map((item) => {
              const pct =
                item.size && item.size > 0
                  ? Math.round((1 - (item.sizeLeft ?? 0) / item.size) * 100)
                  : 0;
              const link =
                item.mediaType === "series" && item.seriesId
                  ? `/series/${item.seriesId}`
                  : item.movieId
                    ? `/movies/${item.movieId}`
                    : null;
              return (
                <TR key={item.id} className="align-top">
                  <TD className="max-w-md pr-3">
                    <div className="truncate font-mono text-xs">{item.title}</div>
                    {link && (
                      <Link href={link} className="text-xs text-amber-400 hover:underline">
                        Go to {item.mediaType === "series" ? "series" : "movie"}
                      </Link>
                    )}
                  </TD>
                  <TD className="pr-3 text-zinc-400">{item.clientName ?? "—"}</TD>
                  <TD className="w-40 pr-3">
                    <div className="h-1.5 rounded bg-zinc-800">
                      <div className="h-1.5 rounded bg-amber-500" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      {formatBytes((item.size ?? 0) - (item.sizeLeft ?? 0))} / {formatBytes(item.size)}
                    </div>
                  </TD>
                  <TD className="pr-3">
                    <Badge tone={statusTone(item.status)} title={item.statusMessage ?? ""}>
                      {STATUS_LABEL[item.status] ?? item.status}
                    </Badge>
                    {item.statusMessage && (
                      <div className="mt-1 max-w-56 text-xs text-zinc-500">{item.statusMessage}</div>
                    )}
                  </TD>
                  <TD className="whitespace-nowrap">
                    <div className="flex flex-wrap justify-end gap-2">
                      {(item.status === "warning" || item.status === "failed") && (
                        <Button variant="secondary" size="sm" onClick={() => retry(item.id)}>
                          Retry import
                        </Button>
                      )}
                      <Button variant="secondary" size="sm" onClick={() => remove(item.id, false)}>
                        Remove
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => remove(item.id, true)}
                        title="Remove, blocklist this release, and search for another"
                      >
                        Blocklist
                      </Button>
                    </div>
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
