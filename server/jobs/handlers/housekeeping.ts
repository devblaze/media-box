import { lt, and, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";

// Prune old completed/failed commands and expired sessions.
export async function housekeeping(): Promise<string> {
  const db = getDb();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);
  const commands = db
    .delete(schema.commands)
    .where(
      and(inArray(schema.commands.status, ["completed", "failed"]), lt(schema.commands.queuedAt, weekAgo))
    )
    .run();
  const sessions = db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date())).run();
  db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
  return `pruned ${commands.changes} commands, ${sessions.changes} sessions`;
}
