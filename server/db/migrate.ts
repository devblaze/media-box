import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb } from "./index";

export function runMigrations() {
  // drizzle/ is copied next to the app in the Docker image; cwd works for dev and standalone
  const migrationsFolder = path.join(process.cwd(), "drizzle");
  migrate(getDb(), { migrationsFolder });
}
