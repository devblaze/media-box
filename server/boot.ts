import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { runMigrations } from "@/server/db/migrate";
import { DEFAULT_PROFILES } from "@/server/parser/quality";
import { DOWNLOADS_DIR, MOVIES_DIR, SERIES_DIR } from "@/server/config/paths";
import { getSettings, setSetting } from "@/server/settings/settings-service";
import { captureConsole } from "@/server/logging/logger";
import {
  SCHEDULED_TASKS,
  recoverInterruptedCommands,
  startScheduler,
} from "@/server/jobs/scheduler";

const BOOT_KEY = Symbol.for("mediabox.booted");

type GlobalWithBoot = typeof globalThis & { [BOOT_KEY]?: boolean };

function seed() {
  const db = getDb();

  for (const task of SCHEDULED_TASKS) {
    const existing = db
      .select({ id: schema.scheduledTasks.id })
      .from(schema.scheduledTasks)
      .where(eq(schema.scheduledTasks.name, task.name))
      .get();
    if (!existing) {
      db.insert(schema.scheduledTasks)
        .values({
          name: task.name,
          intervalMinutes: task.intervalMinutes,
          enabled: true,
          nextRunAt: new Date(Date.now() + 60_000),
        })
        .run();
    }
  }

  const profileCount = db.select({ id: schema.qualityProfiles.id }).from(schema.qualityProfiles).all();
  if (profileCount.length === 0) {
    for (const p of DEFAULT_PROFILES) {
      db.insert(schema.qualityProfiles)
        .values({ name: p.name, upgradeAllowed: true, cutoffQualityId: p.cutoffQualityId, items: p.items })
        .run();
    }
  }

  const naming = db.select().from(schema.namingConfig).get();
  if (!naming) {
    db.insert(schema.namingConfig).values({ id: 1 }).run();
  }

  // Seed library paths from the container env when the operator hasn't set them.
  const settings = getSettings();
  if (!settings.downloadsPath && DOWNLOADS_DIR) setSetting("downloadsPath", DOWNLOADS_DIR);
  if (!settings.moviesPath && MOVIES_DIR) setSetting("moviesPath", MOVIES_DIR);
  if (!settings.seriesPath && SERIES_DIR) setSetting("seriesPath", SERIES_DIR);

  // A fresh env-driven container should be usable without opening the UI: seed
  // default root folders from the movie/series shares when none exist yet.
  const rootFolders = db.select({ id: schema.rootFolders.id }).from(schema.rootFolders).all();
  if (rootFolders.length === 0) {
    if (MOVIES_DIR) {
      db.insert(schema.rootFolders)
        .values({ path: MOVIES_DIR, mediaType: "movies" })
        .onConflictDoNothing()
        .run();
    }
    if (SERIES_DIR) {
      db.insert(schema.rootFolders)
        .values({ path: SERIES_DIR, mediaType: "series" })
        .onConflictDoNothing()
        .run();
    }
  }
}

export async function boot() {
  const g = globalThis as GlobalWithBoot;
  if (g[BOOT_KEY]) return;
  g[BOOT_KEY] = true;

  // Mirror console.error/warn into log_entries as early as possible so any
  // warning/error raised during boot is captured for the admin Logs page.
  captureConsole();

  console.log("[boot] media-box starting");
  runMigrations();
  seed();
  recoverInterruptedCommands();

  // Register job handlers (side-effect imports keep boot.ts the single wiring point)
  await import("@/server/jobs/handlers");

  startScheduler();
  console.log("[boot] media-box ready");
}
