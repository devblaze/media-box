"use client";

import { useApi } from "@/lib/api";
import { useEvents } from "@/lib/use-events";
import {
  Badge,
  EmptyState,
  Skeleton,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "@/components/ui";

interface HistoryRow {
  id: number;
  eventType: string;
  mediaType: "series" | "movie";
  sourceTitle: string | null;
  date: number | string;
  seriesTitle: string | null;
  movieTitle: string | null;
  data: Record<string, unknown> | null;
}

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const EVENT_LABEL: Record<string, { label: string; tone: BadgeTone }> = {
  grabbed: { label: "Grabbed", tone: "accent" },
  imported: { label: "Imported", tone: "success" },
  downloadFailed: { label: "Failed", tone: "danger" },
  fileDeleted: { label: "Deleted", tone: "neutral" },
  fileRenamed: { label: "Renamed", tone: "neutral" },
  ignored: { label: "Ignored", tone: "neutral" },
};

export default function HistoryPage() {
  const { data } = useApi<HistoryRow[]>("/history");
  useEvents();

  return (
    <div>
      <h1 className="text-xl font-semibold">History</h1>
      <div className="mt-4">
        {!data ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : data.length === 0 ? (
          <EmptyState
            title="No history yet."
            description="Grabs, imports, and other activity will show up here."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="w-28">Event</TH>
                <TH>Title</TH>
                <TH>Release</TH>
                <TH className="w-40 text-right">Date</TH>
              </TR>
            </THead>
            <TBody>
              {data.map((h) => {
                const evt = EVENT_LABEL[h.eventType] ?? { label: h.eventType, tone: "neutral" as const };
                return (
                  <TR key={h.id}>
                    <TD className="w-28">
                      <Badge tone={evt.tone}>{evt.label}</Badge>
                    </TD>
                    <TD>{h.seriesTitle ?? h.movieTitle ?? "—"}</TD>
                    <TD className="max-w-md">
                      <span className="block truncate font-mono text-xs text-zinc-400">
                        {h.sourceTitle ?? "—"}
                      </span>
                    </TD>
                    <TD className="w-40 text-right text-xs text-zinc-500">
                      {new Date(h.date).toLocaleString()}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </div>
    </div>
  );
}
