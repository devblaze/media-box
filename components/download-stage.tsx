"use client";

import Link from "next/link";
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
 *
 * A stuck download ("Needs attention" / "Failed") is something the viewer has to
 * decide about, so the badge becomes a link to the queue — where the reason is
 * spelled out and Retry / Remove / Blocklist live. Its tooltip carries the
 * reason too, so hovering answers "what went wrong" without navigating.
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
  // Only show a percentage once we actually know how much is left — otherwise a
  // just-grabbed item (sizeLeft not yet reported) would flash "Downloading 100%".
  const showPct =
    item.status === "downloading" && item.size != null && item.size > 0 && item.sizeLeft != null;
  const stuck = item.status === "warning" || item.status === "failed";
  const tooltip = stuck
    ? `${item.statusMessage ?? "This download didn't import."} — open the queue to retry or remove it.`
    : (item.statusMessage ?? undefined);
  const badge = (
    <Badge
      tone={downloadStatusTone(item.status)}
      className={cn("gap-1", stuck && "hover:brightness-125", className)}
      title={tooltip}
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
  if (!stuck) return badge;
  return (
    <Link
      href="/activity/queue"
      aria-label={`${label} — open the queue`}
      className="inline-flex rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/60"
    >
      {badge}
    </Link>
  );
}
