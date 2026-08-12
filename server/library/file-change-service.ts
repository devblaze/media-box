import { and, count, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { assertFileOperationsEnabled, fileOperationsMode } from "./media-guard";
import { emitEvent } from "@/server/events/bus";

/**
 * Held file-change workflow for "Ask" mode (`fileOperationsMode === "ask"`).
 *
 * When file operations are set to Ask, the operation sites (importer, organizer,
 * library deletes) don't touch disk directly — they record a pending `fileChanges`
 * row via `holdOrRun` / `recordPendingFileChange` and return. An admin (or a user
 * with the `files.approve` permission) then approves it, which re-runs the very
 * same service function with `bypassHold: true` so the real move/rename/delete
 * finally happens (still hard-blocked if the mode has since flipped to "off").
 */

type FileChangeRow = typeof schema.fileChanges.$inferSelect;
export type FileChangeKind = FileChangeRow["kind"];

/** Insert a pending file change and notify listeners. Returns the new row id. */
export function recordPendingFileChange(
  kind: FileChangeKind,
  title: string,
  detail: string | null,
  payload: unknown
): number {
  const db = getDb();
  // Dedupe against the identical operation already awaiting a decision. The
  // callers are retried by their own schedulers — the queue monitor re-offers
  // an unimported download on every tick — so without this the pending list
  // grows without bound (one install reached 241k rows for 104 real imports,
  // which made the page unusable).
  const payloadKey = JSON.stringify(payload ?? null);
  const existing = db
    .select({ id: schema.fileChanges.id })
    .from(schema.fileChanges)
    .where(
      and(
        eq(schema.fileChanges.kind, kind),
        eq(schema.fileChanges.status, "pending"),
        sql`${schema.fileChanges.payload} = ${payloadKey}`
      )
    )
    .get();
  if (existing) return existing.id;

  const row = db
    .insert(schema.fileChanges)
    .values({
      kind,
      status: "pending",
      title,
      detail: detail ?? null,
      payload,
      createdAt: new Date(),
    })
    .returning({ id: schema.fileChanges.id })
    .get();
  emitEvent({ type: "fileChange.pending" });
  return row.id;
}

/**
 * In Ask mode, hold the operation as a pending file change (returning its id)
 * instead of running it; otherwise run it now and return the result. In "off"
 * mode `run()` still executes and throws `MediaWritesDisabledError` through the
 * existing guards — that hard block is intentional.
 */
export async function holdOrRun<T>(
  kind: FileChangeKind,
  title: string,
  detail: string | null,
  payload: unknown,
  run: () => Promise<T>
): Promise<{ held: true; id: number } | { held: false; result: T }> {
  if (fileOperationsMode() === "ask") {
    const id = recordPendingFileChange(kind, title, detail, payload);
    return { held: true, id };
  }
  const result = await run();
  return { held: false, result };
}

/** All file changes, newest first (pending + recently decided). */
export interface ListFileChangesOpts {
  /** Only this status (e.g. "pending"); omit for every status. */
  status?: FileChangeRow["status"];
  /** Page size (default 50, max 200) — the list can be very large. */
  limit?: number;
  offset?: number;
}

export interface FileChangePage {
  items: FileChangeRow[];
  /** Total matching `status` (for paging), and the pending count for the badge. */
  total: number;
  pending: number;
}

/**
 * One page of file changes, newest first. Paged because this table can hold
 * tens of thousands of rows — returning them all made the settings page ship a
 * 100 MB+ payload and lock up the browser.
 */
export function listFileChanges(opts: ListFileChangesOpts = {}): FileChangePage {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = opts.status ? eq(schema.fileChanges.status, opts.status) : undefined;

  const items = db
    .select()
    .from(schema.fileChanges)
    .where(where)
    .orderBy(desc(schema.fileChanges.id))
    .limit(limit)
    .offset(offset)
    .all();

  const total =
    db.select({ n: count() }).from(schema.fileChanges).where(where).get()?.n ?? 0;
  const pending =
    db
      .select({ n: count() })
      .from(schema.fileChanges)
      .where(eq(schema.fileChanges.status, "pending"))
      .get()?.n ?? 0;

  return { items, total, pending };
}

/**
 * Delete duplicate PENDING changes, keeping the newest row per (kind, payload).
 * Repairs installs that accumulated repeats before insertion was deduped.
 * Returns how many rows were removed.
 */
export function pruneDuplicateFileChanges(): number {
  const db = getDb();
  const res = db.run(sql`
    DELETE FROM file_changes
    WHERE status = 'pending'
      AND id NOT IN (
        SELECT MAX(id) FROM file_changes
        WHERE status = 'pending'
        GROUP BY kind, payload
      )
  `);
  const removed = Number(res.changes ?? 0);
  if (removed > 0) emitEvent({ type: "fileChange.pending" });
  return removed;
}

/** Re-run the deferred operation from its stored payload (dynamic imports avoid a
 *  static import cycle with the operation-site modules). */
async function executeFileChange(row: FileChangeRow): Promise<void> {
  switch (row.kind) {
    case "import": {
      const { downloadId } = row.payload as { downloadId: number };
      const { importDownload } = await import("./importer");
      await importDownload(downloadId, { bypassHold: true });
      return;
    }
    case "organize": {
      const { sourcePath, target, onExisting } = row.payload as {
        sourcePath: string;
        target: import("./organizer-service").OrganizeTarget;
        onExisting?: "replace" | "skip";
      };
      const { organizeFile } = await import("./organizer-service");
      await organizeFile(sourcePath, target, { bypassHold: true, onExisting });
      return;
    }
    case "deleteMovie": {
      const { movieId, deleteFiles } = row.payload as { movieId: number; deleteFiles: boolean };
      const { deleteMovie } = await import("./movie-service");
      await deleteMovie(movieId, !!deleteFiles, { bypassHold: true });
      return;
    }
    case "deleteSeries": {
      const { seriesId, deleteFiles } = row.payload as { seriesId: number; deleteFiles: boolean };
      const { deleteSeries } = await import("./series-service");
      await deleteSeries(seriesId, !!deleteFiles, { bypassHold: true });
      return;
    }
    case "deleteVersion": {
      const { movieId, fileId, deleteFile } = row.payload as {
        movieId: number;
        fileId: number;
        deleteFile: boolean;
      };
      const { deleteMovieVersion } = await import("./movie-service");
      await deleteMovieVersion(movieId, fileId, !!deleteFile, { bypassHold: true });
      return;
    }
  }
}

/**
 * Approve a pending change: perform the real file operation, then mark it
 * `applied` (or `failed` with the error). Never throws on an execution failure —
 * the failure is recorded on the row so the approver can see why.
 */
export async function approveFileChange(
  id: number,
  userId: number
): Promise<{ status: "applied" | "failed"; error: string | null }> {
  const db = getDb();
  const row = db.select().from(schema.fileChanges).where(eq(schema.fileChanges.id, id)).get();
  if (!row) throw new Error("File change not found");
  if (row.status !== "pending") throw new Error("File change is not pending");

  // Can't apply file changes while operations are OFF — throw a
  // MediaWritesDisabledError (→ 409) and leave the change pending rather than
  // running a no-op and mislabelling it "applied".
  assertFileOperationsEnabled();

  try {
    await executeFileChange(row);
    db.update(schema.fileChanges)
      .set({ status: "applied", decidedByUserId: userId || null, decidedAt: new Date(), error: null })
      .where(eq(schema.fileChanges.id, id))
      .run();
    emitEvent({ type: "fileChange.updated" });
    return { status: "applied", error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.update(schema.fileChanges)
      .set({ status: "failed", decidedByUserId: userId || null, decidedAt: new Date(), error: message })
      .where(eq(schema.fileChanges.id, id))
      .run();
    emitEvent({ type: "fileChange.updated" });
    return { status: "failed", error: message };
  }
}

/** Decline a pending change: mark it declined and, for a held import, release the
 *  waiting download so it doesn't sit in "waiting for approval" forever. */
export function declineFileChange(id: number, userId: number): void {
  const db = getDb();
  const row = db.select().from(schema.fileChanges).where(eq(schema.fileChanges.id, id)).get();
  if (!row) throw new Error("File change not found");
  if (row.status !== "pending") throw new Error("File change is not pending");

  db.update(schema.fileChanges)
    .set({ status: "declined", decidedByUserId: userId || null, decidedAt: new Date() })
    .where(eq(schema.fileChanges.id, id))
    .run();

  if (row.kind === "import") {
    const { downloadId } = (row.payload as { downloadId?: number }) ?? {};
    if (downloadId != null) {
      db.update(schema.downloads)
        .set({ status: "warning", statusMessage: "Import declined by an approver." })
        .where(eq(schema.downloads.id, downloadId))
        .run();
      emitEvent({ type: "queue.updated" });
    }
  }

  emitEvent({ type: "fileChange.updated" });
}
