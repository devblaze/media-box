import path from "node:path";
import fs from "node:fs";

const isProd = process.env.NODE_ENV === "production";

export const CONFIG_DIR =
  process.env.CONFIG_DIR ?? (isProd ? "/config" : path.join(process.cwd(), ".config-dev"));

export const DB_PATH = path.join(CONFIG_DIR, "media-box.db");
export const LOG_DIR = path.join(CONFIG_DIR, "logs");

// Library share locations, provided by the container/Unraid template. Used only
// to seed settings + default root folders on first boot; the DB is authoritative
// thereafter.
export const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR ?? "";
export const MOVIES_DIR = process.env.MOVIES_DIR ?? "";
export const SERIES_DIR = process.env.SERIES_DIR ?? "";

export function ensureConfigDirs() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}
