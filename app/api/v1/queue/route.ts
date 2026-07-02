import { desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { ok, serverError } from "@/lib/http";

export async function GET() {
  try {
    const db = getDb();
    const rows = db
      .select({
        id: schema.downloads.id,
        title: schema.downloads.title,
        status: schema.downloads.status,
        statusMessage: schema.downloads.statusMessage,
        mediaType: schema.downloads.mediaType,
        seriesId: schema.downloads.seriesId,
        movieId: schema.downloads.movieId,
        size: schema.downloads.size,
        sizeLeft: schema.downloads.sizeLeft,
        quality: schema.downloads.quality,
        grabbedAt: schema.downloads.grabbedAt,
        clientName: schema.downloadClients.name,
        clientType: schema.downloadClients.type,
      })
      .from(schema.downloads)
      .leftJoin(schema.downloadClients, eq(schema.downloadClients.id, schema.downloads.downloadClientId))
      .where(
        inArray(schema.downloads.status, [
          "queued",
          "downloading",
          "remoteCompleted",
          "fetching",
          "importPending",
          "importing",
          "warning",
          "failed",
        ])
      )
      .orderBy(desc(schema.downloads.grabbedAt))
      .all();
    return ok(rows);
  } catch (err) {
    return serverError(err);
  }
}
