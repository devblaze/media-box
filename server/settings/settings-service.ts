import { z } from "zod";
import crypto from "node:crypto";
import { getDb, schema } from "@/server/db";

export const appSettingsSchema = z.object({
  tmdbApiKey: z.string().default(""),
  apiKey: z.string().default(""),
  // Shared secret embedded in kiosk/cast URLs (/tv/<channel>?key=...). A TV or a
  // Fully Kiosk tablet exchanges it for a limited session so channels play with
  // no login. Empty = no link issued yet; admins mint/rotate it from Channels.
  kioskToken: z.string().default(""),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  urlBase: z.string().default(""),
  // Library paths (Unraid: separate shares). Seeded from env on first boot.
  downloadsPath: z.string().default(""),
  moviesPath: z.string().default(""),
  seriesPath: z.string().default(""),
  animePath: z.string().default(""),
  // How imports place files into the library.
  importMode: z.enum(["auto", "hardlink", "copy", "move"]).default("auto"),
  // File-operations mode (3-state master switch for touching media files):
  //   allow — moves/renames/deletes happen freely (the original "on" behaviour).
  //   ask   — file changes are HELD as pending approvals; an admin or a user with
  //           the files.approve permission approves/declines them, and the change
  //           executes on approval.
  //   off   — media-box never moves, renames, or deletes files (the original
  //           read-only mode; endpoints that touch files return 409).
  fileOperationsMode: z.enum(["allow", "ask", "off"]).default("allow"),
  // Legacy boolean master switch, kept in sync with `fileOperationsMode`
  // (`mode !== "off"`). Retained for back-compat: older databases only stored this,
  // and the outer `.transform` below derives the mode from it when the mode key is
  // absent. Reads always reflect `mode !== "off"`.
  fileOperationsEnabled: z.coerce.boolean().default(true),
  // HLS transcoding pipeline.
  transcodeHwAccel: z.enum(["none", "vaapi", "qsv", "nvenc"]).default("none"),
  // DRM render node (/dev/dri/renderD12x) that pins VAAPI *and* QSV to a specific
  // GPU — used to choose the transcode card when the host has more than one.
  transcodeVaapiDevice: z.string().default("/dev/dri/renderD128"),
  maxTranscodeSessions: z.coerce.number().int().min(1).max(10).default(3),
  // Max releases the 24h backlog search grabs per run (slow backfill; 0 = unlimited).
  maxBacklogGrabsPerRun: z.coerce.number().int().min(0).max(50).default(3),
  // Subtitles (Bazarr-style). Wanted languages = comma-separated ISO 639-1 codes ("en,es").
  subtitleLanguages: z.string().default(""),
  // Legacy single-provider selector (kept for back-compat; superseded by subtitleProviders).
  subtitleProvider: z.enum(["none", "opensubtitles"]).default("none"),
  // Enabled providers as a comma-separated id list in priority order, e.g.
  // "opensubtitles,opensubtitlesorg,podnapisi,subs4free". Empty = subtitles off.
  subtitleProviders: z.string().default(""),
  subtitleHearingImpaired: z.coerce.boolean().default(false),
  openSubtitlesApiKey: z.string().default(""),
  openSubtitlesUsername: z.string().default(""),
  openSubtitlesPassword: z.string().default(""),
  // Pushover Application API token (admin) — enables per-user request notifications.
  pushoverAppToken: z.string().default(""),
  // When true, user requests are added to the library immediately (no admin
  // approval step). When false, requests land as "pending" for an admin to
  // approve or decline.
  requestsAutoApprove: z.coerce.boolean().default(false),
  // Optional AI assistant (Ollama or OpenRouter) — powers filename recognition in
  // Library Import and the "Diagnose with AI" button on the Logs page. "none"
  // keeps every AI feature fully inert.
  aiProvider: z.enum(["none", "ollama", "openrouter"]).default("none"),
  ollamaUrl: z.string().default("http://localhost:11434"),
  ollamaModel: z.string().default("llama3.1"),
  openrouterApiKey: z.string().default(""),
  openrouterModel: z.string().default("openai/gpt-4o-mini"),
  // Remembered migration-wizard credentials (last successful connection) so the
  // admin doesn't retype URL + API key each time. Only ever read back by admins.
  sonarrUrl: z.string().default(""),
  sonarrApiKey: z.string().default(""),
  radarrUrl: z.string().default(""),
  radarrApiKey: z.string().default(""),
  bazarrUrl: z.string().default(""),
  bazarrApiKey: z.string().default(""),
}).transform((s) => {
  // Reconcile the 3-state `fileOperationsMode` with the legacy boolean:
  //   - A legacy database has `fileOperationsEnabled=false` with no `fileOperationsMode`
  //     key, so the field default leaves mode="allow" alongside enabled=false — an
  //     impossible pairing that can only mean the mode was absent. Derive "off".
  //   - Otherwise trust the stored mode, and always mirror the boolean off it.
  let mode = s.fileOperationsMode;
  if (mode === "allow" && s.fileOperationsEnabled === false) mode = "off";
  return { ...s, fileOperationsMode: mode, fileOperationsEnabled: mode !== "off" };
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

/** The shared kiosk/cast token, generating + persisting one on first use. */
export function getOrCreateKioskToken(): string {
  const existing = getSettings().kioskToken;
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString("hex");
  setSetting("kioskToken", token);
  return token;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const p: Partial<AppSettings> = { ...patch };
  // Legacy clients still send the boolean; translate it into the 3-state mode so
  // the two never diverge on disk.
  if (p.fileOperationsEnabled !== undefined && p.fileOperationsMode === undefined) {
    p.fileOperationsMode = p.fileOperationsEnabled ? "allow" : "off";
  }
  const current = getSettings();
  const next = appSettingsSchema.parse({ ...current, ...p });
  for (const [key, value] of Object.entries(p)) {
    setSetting(key as keyof AppSettings, value as never);
  }
  // The mode and the legacy boolean are mirrors — persist both whenever either
  // changed so a later read stays consistent regardless of which was written.
  if ("fileOperationsMode" in p || "fileOperationsEnabled" in p) {
    setSetting("fileOperationsMode", next.fileOperationsMode);
    setSetting("fileOperationsEnabled", next.fileOperationsEnabled);
  }
  return next;
}
