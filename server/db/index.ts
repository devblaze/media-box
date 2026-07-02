import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { CONFIG_DIR, DB_PATH, ensureConfigDirs } from "@/server/config/paths";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

const DB_KEY = Symbol.for("mediabox.db");

type GlobalWithDb = typeof globalThis & {
  [DB_KEY]?: { db: Db; sqlite: Database.Database };
};

function create() {
  ensureConfigDirs();
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

// Route handlers, the scheduler, and dev HMR must all share one connection.
function getHandle() {
  const g = globalThis as GlobalWithDb;
  if (!g[DB_KEY]) g[DB_KEY] = create();
  return g[DB_KEY];
}

export function getDb(): Db {
  return getHandle().db;
}

export function getSqlite(): Database.Database {
  return getHandle().sqlite;
}

export { schema, CONFIG_DIR };
