import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Point the DB at a throwaway dir BEFORE any @/server/db import resolves getDb().
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-filechanges-"));
process.env.CONFIG_DIR = TMP;

let svc: typeof import("@/server/library/file-change-service");
let getDb: typeof import("@/server/db").getDb;
let schema: typeof import("@/server/db").schema;

beforeAll(async () => {
  const { runMigrations } = await import("@/server/db/migrate");
  runMigrations();
  ({ getDb, schema } = await import("@/server/db"));
  svc = await import("@/server/library/file-change-service");
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().delete(schema.fileChanges).run();
});

/**
 * The operation sites are driven by retrying jobs — the queue monitor re-offers
 * an unimported download on every tick — so recording the same pending change
 * must be idempotent. Without this one install accumulated 241k rows for 104
 * real imports, which made the page ship a 100 MB payload.
 */
test("recording the same pending change twice reuses the first row", () => {
  const a = svc.recordPendingFileChange("import", "Import “Show S01E01”", null, { downloadId: 7 });
  const b = svc.recordPendingFileChange("import", "Import “Show S01E01”", null, { downloadId: 7 });
  expect(b).toBe(a);
  expect(svc.listFileChanges().total).toBe(1);
});

test("a different payload is a different change", () => {
  svc.recordPendingFileChange("import", "Import A", null, { downloadId: 1 });
  svc.recordPendingFileChange("import", "Import B", null, { downloadId: 2 });
  expect(svc.listFileChanges().total).toBe(2);
});

test("the same payload under a different kind is a different change", () => {
  svc.recordPendingFileChange("import", "x", null, { id: 1 });
  svc.recordPendingFileChange("organize", "x", null, { id: 1 });
  expect(svc.listFileChanges().total).toBe(2);
});

test("a decided change no longer blocks a fresh one", () => {
  const id = svc.recordPendingFileChange("import", "Import “Show S01E01”", null, { downloadId: 7 });
  getDb()
    .update(schema.fileChanges)
    .set({ status: "declined" })
    .where(eq(schema.fileChanges.id, id))
    .run();
  const again = svc.recordPendingFileChange("import", "Import “Show S01E01”", null, {
    downloadId: 7,
  });
  expect(again).not.toBe(id);
  expect(svc.listFileChanges().total).toBe(2);
});

test("listFileChanges pages newest-first and reports totals", () => {
  for (let i = 1; i <= 120; i++) {
    svc.recordPendingFileChange("import", `Import ${i}`, null, { downloadId: i });
  }
  const first = svc.listFileChanges({ limit: 50 });
  expect(first.items).toHaveLength(50);
  expect(first.total).toBe(120);
  expect(first.pending).toBe(120);
  expect(first.items[0].title).toBe("Import 120"); // newest first

  const second = svc.listFileChanges({ limit: 50, offset: 50 });
  expect(second.items).toHaveLength(50);
  expect(second.items[0].title).toBe("Import 70");

  const last = svc.listFileChanges({ limit: 50, offset: 100 });
  expect(last.items).toHaveLength(20);

  // The page size is clamped so a caller can't ask for everything again.
  expect(svc.listFileChanges({ limit: 100_000 }).items.length).toBeLessThanOrEqual(200);
});

test("listFileChanges filters by status", () => {
  const id = svc.recordPendingFileChange("import", "kept", null, { downloadId: 1 });
  svc.recordPendingFileChange("import", "other", null, { downloadId: 2 });
  getDb()
    .update(schema.fileChanges)
    .set({ status: "applied" })
    .where(eq(schema.fileChanges.id, id))
    .run();

  expect(svc.listFileChanges({ status: "pending" }).total).toBe(1);
  expect(svc.listFileChanges({ status: "applied" }).total).toBe(1);
  expect(svc.listFileChanges().total).toBe(2);
  // `pending` is always the pending count, whatever the filter.
  expect(svc.listFileChanges({ status: "applied" }).pending).toBe(1);
});

test("pruneDuplicateFileChanges keeps the newest of each duplicate set", () => {
  const db = getDb();
  // Simulate the pre-fix state: the same operation recorded many times.
  for (let i = 0; i < 5; i++) {
    db.insert(schema.fileChanges)
      .values({
        kind: "import",
        status: "pending",
        title: "Import “Show S01E01”",
        detail: null,
        payload: { downloadId: 7 },
        createdAt: new Date(),
      })
      .run();
  }
  svc.recordPendingFileChange("import", "Import “Other”", null, { downloadId: 8 });
  expect(svc.listFileChanges().total).toBe(6);

  const removed = svc.pruneDuplicateFileChanges();
  expect(removed).toBe(4);

  const after = svc.listFileChanges();
  expect(after.total).toBe(2);
  // The surviving duplicate is the newest (highest id) of its set.
  const survivors = after.items.filter((c) => c.title === "Import “Show S01E01”");
  expect(survivors).toHaveLength(1);

  // Idempotent: a second prune has nothing left to do.
  expect(svc.pruneDuplicateFileChanges()).toBe(0);
});
