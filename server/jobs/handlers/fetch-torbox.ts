import path from "node:path";
import fs from "node:fs/promises";
import fscb from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { TorboxClient } from "@/server/download/torbox";
import { torboxSettingsSchema } from "@/server/download/client";
import { freeSpace } from "@/server/library/filesystem";
import { enqueueCommand } from "@/server/jobs/scheduler";
import { sanitizePathComponent } from "@/server/library/naming-utils";
import { emitEvent } from "@/server/events/bus";

const VIDEO_RE = /\.(mkv|mp4|avi|m4v|ts|wmv)$/i;

export async function fetchTorboxHandler(payload: unknown): Promise<string> {
  const { downloadId } = payload as { downloadId: number };
  const db = getDb();
  const download = db.select().from(schema.downloads).where(eq(schema.downloads.id, downloadId)).get();
  if (!download) throw new Error(`Download ${downloadId} not found`);

  const clientRow = db
    .select()
    .from(schema.downloadClients)
    .where(eq(schema.downloadClients.id, download.downloadClientId))
    .get();
  if (!clientRow || clientRow.type !== "torbox") throw new Error("Not a TorBox download");

  const settings = torboxSettingsSchema.parse(clientRow.settings);
  const client = new TorboxClient(settings);

  try {
    const files = (await client.getFiles(download.externalId)).filter((f) => VIDEO_RE.test(f.name));
    if (files.length === 0) throw new Error("No video files in TorBox torrent");

    const destDir = path.join(settings.stagingDir, sanitizePathComponent(download.title));
    await fs.mkdir(destDir, { recursive: true });

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    if ((await freeSpace(destDir)) < totalSize + 500 * 1024 * 1024) {
      throw new Error("Not enough free space in the TorBox staging directory");
    }

    for (const file of files) {
      const dest = path.join(destDir, path.basename(file.name));
      const existing = await fs.stat(dest).catch(() => null);
      if (existing && existing.size === file.size) continue; // already fetched

      const url = await client.getDownloadUrl(download.externalId, file.id);
      const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`TorBox file download failed (${res.status})`);
      const tmp = `${dest}.partial~`;
      await pipeline(
        Readable.fromWeb(res.body as import("stream/web").ReadableStream),
        fscb.createWriteStream(tmp)
      );
      await fs.rename(tmp, dest);
    }

    db.update(schema.downloads)
      .set({ status: "importPending", outputPath: destDir, sizeLeft: 0 })
      .where(eq(schema.downloads.id, downloadId))
      .run();
    emitEvent({ type: "queue.updated" });
    enqueueCommand("ImportDownload", { downloadId }, "system", 5);
    return `fetched ${files.length} file(s) to ${destDir}`;
  } catch (err) {
    db.update(schema.downloads)
      .set({
        status: "failed",
        statusMessage: `TorBox fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      .where(eq(schema.downloads.id, downloadId))
      .run();
    emitEvent({ type: "queue.updated" });
    throw err;
  }
}
