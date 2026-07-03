import { eq } from "drizzle-orm";
import { z } from "zod";
import crypto from "node:crypto";
import { getDb, schema } from "@/server/db";

export const appSettingsSchema = z.object({
  tmdbApiKey: z.string().default(""),
  apiKey: z.string().default(""),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  urlBase: z.string().default(""),
  // Library paths (Unraid: separate shares). Seeded from env on first boot.
  downloadsPath: z.string().default(""),
  moviesPath: z.string().default(""),
  seriesPath: z.string().default(""),
  animePath: z.string().default(""),
  // How imports place files into the library.
  importMode: z.enum(["auto", "hardlink", "copy", "move"]).default("auto"),
  // HLS transcoding pipeline.
  transcodeHwAccel: z.enum(["none", "vaapi", "qsv", "nvenc"]).default("none"),
  transcodeVaapiDevice: z.string().default("/dev/dri/renderD128"),
  maxTranscodeSessions: z.coerce.number().int().min(1).max(10).default(3),
  // Max releases the 24h backlog search grabs per run (slow backfill; 0 = unlimited).
  maxBacklogGrabsPerRun: z.coerce.number().int().min(0).max(50).default(3),
  // Subtitles (Bazarr-style). Wanted languages = comma-separated ISO 639-1 codes ("en,es").
  subtitleLanguages: z.string().default(""),
  subtitleProvider: z.enum(["none", "opensubtitles"]).default("none"),
  subtitleHearingImpaired: z.coerce.boolean().default(false),
  openSubtitlesApiKey: z.string().default(""),
  openSubtitlesUsername: z.string().default(""),
  openSubtitlesPassword: z.string().default(""),
  // Pushover Application API token (admin) — enables per-user request notifications.
  pushoverAppToken: z.string().default(""),
  // Remembered migration-wizard credentials (last successful connection) so the
  // admin doesn't retype URL + API key each time. Only ever read back by admins.
  sonarrUrl: z.string().default(""),
  sonarrApiKey: z.string().default(""),
  radarrUrl: z.string().default(""),
  radarrApiKey: z.string().default(""),
  bazarrUrl: z.string().default(""),
  bazarrApiKey: z.string().default(""),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

export function getSettings(): AppSettings {
  const db = getDb();
  const rows = db.select().from(schema.settings).all();
  const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const parsed = appSettingsSchema.parse(raw);
  if (!parsed.apiKey) {
    parsed.apiKey = crypto.randomBytes(16).toString("hex");
    setSetting("apiKey", parsed.apiKey);
  }
  return parsed;
}

export function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
  const db = getDb();
  db.insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  const next = appSettingsSchema.parse({ ...current, ...patch });
  for (const [key, value] of Object.entries(patch)) {
    setSetting(key as keyof AppSettings, value as never);
  }
  return next;
}
