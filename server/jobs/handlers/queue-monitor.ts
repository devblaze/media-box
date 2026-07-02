import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getClient } from "@/server/download/client";
import { enqueueCommand } from "@/server/jobs/scheduler";
import { emitEvent } from "@/server/events/bus";

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
          if (download.status !== "downloading") patch.status = "downloading";
          break;
        case "error":
          patch.status = "failed";
          patch.statusMessage = item.message ?? "Client reported an error";
          break;
        case "localComplete":
          if (download.status !== "importPending") {
            patch.status = "importPending";
            patch.outputPath = item.savePath ?? null;
            enqueueCommand("ImportDownload", { downloadId: download.id }, "system", 5);
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
