import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Point the DB at a throwaway dir BEFORE any @/server/db import resolves getDb().
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mediabox-logs-"));
process.env.CONFIG_DIR = TMP;

let logger: typeof import("@/server/logging/logger");

beforeAll(async () => {
  const { runMigrations } = await import("@/server/db/migrate");
  runMigrations();
  logger = await import("@/server/logging/logger");

  // 15 info + 10 error rows, in a known order (info 1..15 first, then error 1..10).
  for (let i = 1; i <= 15; i++) logger.recordLog("info", `info ${i}`, { source: "test" });
  for (let i = 1; i <= 10; i++) logger.recordLog("error", `error ${i}`, { source: "test" });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("listLogs pagination", () => {
  it("reports the filtered totals", () => {
    expect(logger.listLogs({ limit: 1, offset: 0 }).total).toBe(25);
    expect(logger.listLogs({ level: "error", limit: 1, offset: 0 }).total).toBe(10);
    expect(logger.listLogs({ level: "debug", limit: 1, offset: 0 }).total).toBe(0);
  });

  it("pages newest-first with a stable order across pages", () => {
    const page1 = logger.listLogs({ limit: 10, offset: 0 });
    const page2 = logger.listLogs({ limit: 10, offset: 10 });
    const page3 = logger.listLogs({ limit: 10, offset: 20 });
    expect(page1.entries).toHaveLength(10);
    expect(page2.entries).toHaveLength(10);
    expect(page3.entries).toHaveLength(5);

    // Newest first: the last insert (error 10) leads page 1.
    expect(page1.entries[0].message).toBe("error 10");
    // No overlap or gaps across the three pages.
    const ids = [...page1.entries, ...page2.entries, ...page3.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(25);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    // The oldest insert lands at the very end.
    expect(page3.entries.at(-1)?.message).toBe("info 1");
  });

  it("applies the level filter within pages", () => {
    const errors = logger.listLogs({ level: "error", limit: 4, offset: 8 });
    expect(errors.entries).toHaveLength(2); // 10 errors total → offset 8 leaves 2
    expect(errors.entries.every((e) => e.level === "error")).toBe(true);
    expect(errors.entries.at(-1)?.message).toBe("error 1");
  });

  it("returns an empty page past the end, with the total intact", () => {
    const past = logger.listLogs({ limit: 10, offset: 100 });
    expect(past.entries).toHaveLength(0);
    expect(past.total).toBe(25);
  });
});

describe("recordLog", () => {
  it("stores level, source, and JSON context", () => {
    logger.recordLog("warn", "with context", { source: "unit", context: { a: 1 } });
    const { entries } = logger.listLogs({ level: "warn", limit: 1, offset: 0 });
    expect(entries[0].message).toBe("with context");
    expect(entries[0].source).toBe("unit");
    expect(entries[0].context).toEqual({ a: 1 });
  });
});
