import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getClient } from "@/server/download/client";
import { enqueueCommand } from "@/server/jobs/scheduler";
import { emitEvent } from "@/server/events/bus";
import { recordDownloadFailure } from "@/server/download/failure-log";
import { fileOperationsEnabled } from "@/server/library/media-guard";
import type { QualityModel } from "@/server/parser/quality";

/** Persist a durable failure row for a download the monitor just marked failed. */
function logQueueFailure(download: typeof schema.downloads.$inferSelect, reason: string): void {
  recordDownloadFailure({
    mediaType: download.mediaType,
    seriesId: download.seriesId,
    movieId: download.movieId,
    episodeIds: download.episodeIds as number[] | null,
    sourceTitle: download.title,
    quality: download.quality as QualityModel | null,
    indexerId: download.indexerId,
    downloadClientId: download.downloadClientId,
    downloadExternalId: download.externalId,
    reason,
    stage: "download",
  });
}

const ACTIVE_STATUSES = ["queued", "downloading", "remoteCompleted", "fetching", "importPending"] as const;

export async function queueMonitorHandler(): Promise<string> {
  const db = getDb();
  const active = db
    .select()
    .from(schema.downloads)
    .where(inArray(schema.downloads.status, [...ACTIVE_STATUSES]))
    .all();
  if (active.length === 0) return "queue empty";

  const byClient = new Map<number, typeof active>();
  for (const d of active) {
    const list = byClient.get(d.downloadClientId) ?? [];
    list.push(d);
    byClient.set(d.downloadClientId, list);
  }

  let updates = 0;
  for (const [clientId, downloads] of byClient) {
    const clientRow = db
      .select()
      .from(schema.downloadClients)
      .where(eq(schema.downloadClients.id, clientId))
      .get();
    if (!clientRow) continue;

    let items;
    try {
      const client = await getClient(clientRow);
      items = await client.getItems();
    } catch (err) {
      console.warn(`[queue-monitor] client '${clientRow.name}' unreachable:`, err);
      continue;
    }
    const itemsById = new Map(items.map((i) => [i.externalId, i]));

    for (const download of downloads) {
      const item = itemsById.get(download.externalId);
      if (!item) {
        // vanished from the client (removed manually) — mark failed unless we're already importing
        if (download.status !== "importPending" && download.status !== "fetching") {
          db.update(schema.downloads)
            .set({ status: "failed", statusMessage: "Download disappeared from the client" })
            .where(eq(schema.downloads.id, download.id))
            .run();
          logQueueFailure(download, "Download disappeared from the client");
          updates++;
        }
        continue;
      }

      const patch: Partial<typeof schema.downloads.$inferInsert> = {
        size: item.size || download.size,
        sizeLeft: item.sizeLeft,
      };

      switch (item.status) {
        case "downloading":
        case "queued":
        case "stalled":
          // Don't downgrade a download that's already past active downloading —
          // in particular one held in `importPending` awaiting file-change
          // approval (a client recheck reporting "downloading" would otherwise
          // flip it back and, on the next localComplete tick, record a duplicate
          // pending change).
          if (download.status !== "downloading" && download.status !== "importPending")
            patch.status = "downloading";
          break;
        case "error":
          patch.status = "failed";
          patch.statusMessage = item.message ?? "Client reported an error";
          logQueueFailure(download, patch.statusMessage);
          break;
        case "localComplete":
          if (download.status !== "importPending") {
            // Read-only mode: don't kick off an import. Leave the download active
            // (with an explanatory message) so this same branch re-triggers the
            // import automatically on a later tick once it's turned back on.
            if (fileOperationsEnabled()) {
              patch.status = "importPending";
              patch.outputPath = item.savePath ?? null;
              enqueueCommand("ImportDownload", { downloadId: download.id }, "system", 5);
            } else {
              patch.outputPath = item.savePath ?? null;
              patch.statusMessage =
                "File operations are disabled — will import when you re-enable them.";
            }
          }
          break;
        case "remoteCompleted":
          // TorBox: finished server-side; fetch files down before import
          if (download.status !== "fetching") {
            patch.status = "fetching";
            enqueueCommand("FetchTorboxFiles", { downloadId: download.id }, "system", 5);
          }
          break;
      }

      const changed = Object.keys(patch).some(
        (k) => (download as Record<string, unknown>)[k] !== (patch as Record<string, unknown>)[k]
      );
      if (changed) {
        db.update(schema.downloads).set(patch).where(eq(schema.downloads.id, download.id)).run();
        updates++;
      }
    }
  }

  if (updates > 0) emitEvent({ type: "queue.updated" });
  return `${active.length} active, ${updates} updated`;
}
