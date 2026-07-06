"use client";

import { useApi } from "@/lib/api";
import {
  DOWNLOAD_STATUS_LABEL,
  downloadProgress,
  downloadStatusTone,
  type QueueItem,
} from "@/lib/download-status";
import { Badge } from "@/components/ui";
import { cn } from "@/lib/cn";

/**
 * Live download queue for the current viewer. Backed by `GET /api/v1/queue`,
 * which the page's `useEvents()` revalidates on every `queue.updated` SSE — so
 * per-title download indicators built on this stay live as downloads progress.
 */
export function useQueue(): QueueItem[] | undefined {
  const { data } = useApi<QueueItem[]>("/queue");
  return data;
}

/**
 * A compact "what stage is this download at" badge for a single active download:
 * e.g. "Downloading 45%", "Waiting to import", "Failed". Progress is appended
 * only while actually downloading (when a percentage is meaningful).
 */
export function DownloadStageBadge({
  item,
  className,
}: {
  item: QueueItem;
  className?: string;
}) {
  const pct = downloadProgress(item);
  const label = DOWNLOAD_STATUS_LABEL[item.status] ?? item.status;
  const showPct = item.status === "downloading" && item.size != null && item.size > 0;
  return (
    <Badge
      tone={downloadStatusTone(item.status)}
      className={cn("gap-1", className)}
      title={item.statusMessage ?? undefined}
    >
      <svg
        viewBox="0 0 24 24"
        className="size-3"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
      {label}
      {showPct ? ` ${pct}%` : ""}
    </Badge>
  );
}
