import type { ComponentProps } from "react";
import type { Badge } from "@/components/ui/badge";

/**
 * One active download from `GET /api/v1/queue`. Shared by the Queue page and the
 * per-title download indicators on the movie/series detail pages so the status
 * naming stays consistent everywhere.
 */
export interface QueueItem {
  id: number;
  title: string;
  status: string;
  statusMessage: string | null;
  mediaType: "series" | "movie";
  seriesId: number | null;
  movieId: number | null;
  episodeIds: number[] | null;
  size: number | null;
  sizeLeft: number | null;
  grabbedAt: number | string;
  clientName: string | null;
  clientType: string | null;
}

type Tone = NonNullable<ComponentProps<typeof Badge>["tone"]>;

/** Human-readable label for each `downloads.status`. */
export const DOWNLOAD_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  downloading: "Downloading",
  remoteCompleted: "Completed (remote)",
  fetching: "Fetching from TorBox",
  importPending: "Waiting to import",
  importing: "Importing",
  warning: "Needs attention",
  failed: "Failed",
};

/** Badge colour for a download status. */
export function downloadStatusTone(status: string): Tone {
  if (status === "failed" || status === "warning") return "danger";
  if (status === "importPending" || status === "importing") return "success";
  if (status === "downloading" || status === "fetching") return "info";
  return "neutral";
}

/** Completion percentage (0–100) from size / sizeLeft; 0 when size is unknown. */
export function downloadProgress(item: Pick<QueueItem, "size" | "sizeLeft">): number {
  return item.size && item.size > 0
    ? Math.max(0, Math.min(100, Math.round((1 - (item.sizeLeft ?? 0) / item.size) * 100)))
    : 0;
}

/** Whether a status is still active (not a terminal failure the user must act on). */
export function isActiveDownload(status: string): boolean {
  return status !== "failed" && status !== "warning";
}

/** The active download for a movie, if any. */
export function movieQueueItem(items: QueueItem[] | undefined, movieId: number): QueueItem | null {
  return items?.find((d) => d.mediaType === "movie" && d.movieId === movieId) ?? null;
}

/** All active downloads for a series (any season/episode). */
export function seriesQueueItems(items: QueueItem[] | undefined, seriesId: number): QueueItem[] {
  return items?.filter((d) => d.mediaType === "series" && d.seriesId === seriesId) ?? [];
}

/** The active download that includes a specific episode, if any. */
export function episodeQueueItem(
  items: QueueItem[] | undefined,
  episodeId: number
): QueueItem | null {
  return items?.find((d) => Array.isArray(d.episodeIds) && d.episodeIds.includes(episodeId)) ?? null;
}
