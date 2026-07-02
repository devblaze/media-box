import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getClient } from "./client";
import type { DecoratedRelease } from "@/server/indexers/release-search";
import { emitEvent } from "@/server/events/bus";

export interface GrabTarget {
  mediaType: "series" | "movie";
  seriesId?: number;
  movieId?: number;
  episodeIds?: number[];
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
      return download ?? { externalId };
    } catch (err) {
      lastError = err;
      console.error(`[grab] client '${row.name}' failed:`, err);
    }
  }
  throw new Error(
    `All download clients failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}
