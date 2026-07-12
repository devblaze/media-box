import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getClient } from "./client";
import type { DecoratedRelease } from "@/server/indexers/release-search";
import { emitEvent } from "@/server/events/bus";
import { recordDownloadFailure } from "./failure-log";
import { recordLog } from "@/server/logging/logger";

export interface GrabTarget {
  mediaType: "series" | "movie";
  seriesId?: number;
  movieId?: number;
  episodeIds?: number[];
  /** Manual override — import even if it isn't an upgrade over the current file. */
  override?: boolean;
}

export async function grab(release: DecoratedRelease, target: GrabTarget) {
  const db = getDb();
  const clientRows = db
    .select()
    .from(schema.downloadClients)
    .where(eq(schema.downloadClients.enabled, true))
    .orderBy(asc(schema.downloadClients.priority))
    .all();
  if (clientRows.length === 0) throw new Error("No enabled download client configured");

  let lastError: unknown;
  for (const row of clientRows) {
    try {
      const client = await getClient(row);
      const category =
        row.type === "qbittorrent"
          ? ((row.settings as { category?: string }).category ?? "media-box")
          : "media-box";
      const { externalId } = await client.add({
        magnetUrl: release.magnetUrl,
        torrentFileUrl: release.magnetUrl ? undefined : release.downloadUrl,
        // Lets the client fall back to a synthesized magnet when the indexer's
        // .torrent link turns out to be dead/expired.
        infoHash: release.infoHash ?? undefined,
        title: release.title,
        category,
      });

      const download = db
        .insert(schema.downloads)
        .values({
          downloadClientId: row.id,
          externalId,
          mediaType: target.mediaType,
          seriesId: target.seriesId ?? null,
          movieId: target.movieId ?? null,
          episodeIds: target.episodeIds ?? null,
          title: release.title,
          quality: release.parsed.quality,
          indexerId: release.indexerId,
          status: "queued",
          size: release.size,
          sizeLeft: release.size,
          override: target.override ?? false,
          grabbedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning()
        .get();

      db.insert(schema.history)
        .values({
          eventType: "grabbed",
          mediaType: target.mediaType,
          seriesId: target.seriesId ?? null,
          movieId: target.movieId ?? null,
          episodeId: target.episodeIds?.[0] ?? null,
          sourceTitle: release.title,
          quality: release.parsed.quality,
          indexerId: release.indexerId,
          downloadClientId: row.id,
          downloadExternalId: externalId,
          data: { indexerName: release.indexerName, size: release.size },
          date: new Date(),
        })
        .run();

      emitEvent({ type: "queue.updated" });
      emitEvent({ type: "history.added" });
      // Success breadcrumb for the admin Logs page — the failure paths below and
      // in the queue/import handlers already log, so log the wins too and the page
      // reflects the real grab success rate instead of only failures.
      recordLog("info", `[grab] sent '${release.title}' to '${row.name}'`, {
        source: "grab",
        context: {
          client: row.name,
          indexer: release.indexerName,
          size: release.size,
          mediaType: target.mediaType,
          externalId,
        },
      });
      return download ?? { externalId };
    } catch (err) {
      lastError = err;
      console.error(`[grab] client '${row.name}' failed:`, err);
    }
  }
  const reason = `All download clients failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
  recordDownloadFailure({
    mediaType: target.mediaType,
    seriesId: target.seriesId ?? null,
    movieId: target.movieId ?? null,
    episodeIds: target.episodeIds ?? null,
    sourceTitle: release.title,
    quality: release.parsed.quality,
    indexerId: release.indexerId,
    reason,
    stage: "grab",
  });
  throw new Error(reason);
}
