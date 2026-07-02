// Importer for an existing Bazarr instance.
//
// Unlike the Sonarr/Radarr migration (which maps into media-box libraries), Bazarr
// only carries subtitle configuration, so this maps straight into app settings:
//   - wanted languages  -> subtitleLanguages
//   - OpenSubtitles.com  -> subtitleProvider + openSubtitles* credentials
//
// Bazarr's settings JSON shape shifts between versions, so every extraction below is
// defensive: optional chaining, key fallbacks, and never throwing on a missing field.

import { updateSettings, type AppSettings } from "@/server/settings/settings-service";

export class BazarrError extends Error {}

export interface BazarrImportResult {
  languages: string[];
  provider: string;
  imported: boolean;
  note?: string;
}

async function bazarrGet<T>(baseUrl: string, apiKey: string, path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { "X-API-KEY": apiKey },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) {
    throw new BazarrError(
      "Bazarr rejected the API key (401) — check Settings → General → Security in Bazarr."
    );
  }
  if (!res.ok) throw new BazarrError(`Bazarr ${path} responded ${res.status}`);
  return res.json() as Promise<T>;
}

/** First non-empty string among the given keys of an object-ish value. */
function pickString(obj: unknown, ...keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Enabled language `code2`s from Bazarr's languages endpoint (array of {code2,name,enabled}). */
function extractLanguages(raw: unknown): string[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown>)?.data)
      ? ((raw as Record<string, unknown>).data as unknown[])
      : [];
  const codes: string[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.enabled === false) continue;
    const code = rec.code2 ?? rec.code ?? rec.code3;
    if (typeof code === "string" && code.trim()) codes.push(code.trim().toLowerCase());
  }
  return [...new Set(codes)];
}

/** Fallback: pull enabled languages out of the big settings blob if the languages call failed. */
function languagesFromSettings(settings: Record<string, unknown> | null): string[] {
  if (!settings) return [];
  const general = settings.general as Record<string, unknown> | undefined;
  const candidates = [
    general?.enabled_languages,
    general?.enabledLanguages,
    settings.languages,
    (settings.languages as Record<string, unknown> | undefined)?.enabled,
  ];
  for (const c of candidates) {
    const codes = extractLanguages(c);
    if (codes.length) return codes;
  }
  return [];
}

/**
 * Connect to a Bazarr instance and import its subtitle configuration into media-box settings.
 * Returns a summary; degrades gracefully when languages or credentials are absent.
 */
export async function importFromBazarr(conn: {
  baseUrl: string;
  apiKey: string;
}): Promise<BazarrImportResult> {
  const baseUrl = conn.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = conn.apiKey.trim();
  if (!baseUrl) throw new BazarrError("A Bazarr URL is required.");
  if (!apiKey) throw new BazarrError("A Bazarr API key is required.");

  // Fetch settings first: this validates the connection + API key and gives us credentials.
  const settings = await bazarrGet<Record<string, unknown>>(baseUrl, apiKey, "/api/system/settings");

  // Prefer the dedicated languages endpoint; fall back to the settings blob on failure.
  let languages: string[] = [];
  try {
    const raw = await bazarrGet<unknown>(baseUrl, apiKey, "/api/system/languages?enabled=true");
    languages = extractLanguages(raw);
  } catch {
    // older Bazarr / endpoint unavailable — degrade to the settings blob
  }
  if (!languages.length) languages = languagesFromSettings(settings);

  // Extract OpenSubtitles.com credentials defensively; the section name varies by version.
  const osCom = settings.opensubtitlescom ?? settings.openSubtitlesCom;
  const osLegacy = settings.opensubtitles ?? settings.openSubtitles;
  const username =
    pickString(osCom, "username", "user", "email") ??
    pickString(osLegacy, "username", "user", "email");
  const password =
    pickString(osCom, "password", "pass") ?? pickString(osLegacy, "password", "pass");
  const openSubtitlesApiKey =
    pickString(osCom, "apikey", "api_key", "apiKey", "token") ??
    pickString(osLegacy, "apikey", "api_key", "apiKey", "token");

  const hasCreds = Boolean((username && password) || openSubtitlesApiKey);

  const patch: Partial<AppSettings> = {};
  if (languages.length) patch.subtitleLanguages = languages.join(",");
  if (username) patch.openSubtitlesUsername = username;
  if (password) patch.openSubtitlesPassword = password;
  if (openSubtitlesApiKey) patch.openSubtitlesApiKey = openSubtitlesApiKey;

  let provider = "none";
  let note: string | undefined;
  if (hasCreds) {
    provider = "opensubtitles";
    patch.subtitleProvider = "opensubtitles";
  } else if (languages.length) {
    provider = "opensubtitles";
    patch.subtitleProvider = "opensubtitles";
    note =
      "OpenSubtitles credentials were not found in Bazarr — enter them under Settings → Subtitles.";
  } else {
    note = "No enabled languages or OpenSubtitles credentials were found in Bazarr.";
  }

  updateSettings(patch);

  return { languages, provider, imported: true, note };
}
