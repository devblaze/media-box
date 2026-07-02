import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getClient } from "@/server/download/client";
import { enqueueCommand } from "@/server/jobs/scheduler";
import { badRequest, notFound, ok, serverError } from "@/lib/http";
import { emitEvent } from "@/server/events/bus";

// POST = retry import; DELETE = remove (optionally blocklist + remove from client)
export async function POST(_req: NextRequest, ctx: RouteContext<"/api/v1/queue/[id]">) {
  try {
    const { id } = await ctx.params;
    const downloadId = Number(id);
    const db = getDb();
    const row = db.select().from(schema.downloads).where(eq(schema.downloads.id, downloadId)).get();
    if (!row) return notFound("Queue item not found");
    enqueueCommand("ImportDownload", { downloadId }, "manual", 10);
    return ok({ retrying: true });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/v1/queue/[id]">) {
  try {
    const { id } = await ctx.params;
    const downloadId = Number(id);
    if (!Number.isInteger(downloadId)) return badRequest("Invalid id");
    const blocklist = request.nextUrl.searchParams.get("blocklist") === "true";
    const removeFromClient = request.nextUrl.searchParams.get("removeFromClient") !== "false";

    const db = getDb();
    const row = db.select().from(schema.downloads).where(eq(schema.downloads.id, downloadId)).get();
    if (!row) return notFound("Queue item not found");

    if (removeFromClient) {
      const clientRow = db
        .select()
        .from(schema.downloadClients)
        .where(eq(schema.downloadClients.id, row.downloadClientId))
        .get();
      if (clientRow) {
        try {
          const client = await getClient(clientRow);
          await client.remove(row.externalId, true);
        } catch (err) {
          console.warn("[queue] failed to remove from client:", err);
        }
      }
    }

    if (blocklist) {
      db.insert(schema.blocklist)
        .values({
          mediaType: row.mediaType,
          seriesId: row.seriesId,
          movieId: row.movieId,
          sourceTitle: row.title,
          infoHash: row.externalId.length === 40 ? row.externalId : null,
          reason: "Blocklisted from queue",
          date: new Date(),
        })
        .run();
    }

    db.delete(schema.downloads).where(eq(schema.downloads.id, downloadId)).run();
    emitEvent({ type: "queue.updated" });
    return ok({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}
