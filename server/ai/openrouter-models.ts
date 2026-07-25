/**
 * OpenRouter model catalog for the Settings → AI assistant model picker.
 * Fetched from OpenRouter's public /models endpoint (no API key required) and
 * cached in-process for an hour — the list changes rarely and the settings page
 * shouldn't hammer a third party.
 */

export interface OpenRouterModel {
  id: string;
  name: string;
  /** True when both prompt and completion pricing are 0 (the ":free" variants). */
  free: boolean;
}

/**
 * Map OpenRouter's /models payload to our picker shape. Pricing comes as
 * decimal STRINGS ("0", "0.0000006"); anything malformed counts as paid.
 * Entries without a usable id are dropped. Sorted by id for a stable list.
 */
export function parseOpenRouterModels(payload: unknown): OpenRouterModel[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const models: OpenRouterModel[] = [];
  for (const raw of data) {
    const m = raw as {
      id?: unknown;
      name?: unknown;
      pricing?: { prompt?: unknown; completion?: unknown } | null;
    };
    if (typeof m.id !== "string" || m.id.length === 0) continue;
    const prompt = Number(m.pricing?.prompt);
    const completion = Number(m.pricing?.completion);
    models.push({
      id: m.id,
      name: typeof m.name === "string" && m.name.length > 0 ? m.name : m.id,
      free: prompt === 0 && completion === 0,
    });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_KEY = Symbol.for("mediabox.openrouterModels");

interface ModelCache {
  at: number;
  models: OpenRouterModel[];
}

type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: ModelCache };

/** The model list, from cache when fresh. A fetch failure serves a stale cache
 *  if one exists, and only throws when there is nothing at all to show. */
export async function getOpenRouterModels(): Promise<OpenRouterModel[]> {
  const g = globalThis as GlobalWithCache;
  const cached = g[CACHE_KEY];
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.models;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`OpenRouter /models responded ${res.status}`);
    const models = parseOpenRouterModels(await res.json());
    g[CACHE_KEY] = { at: Date.now(), models };
    return models;
  } catch (err) {
    if (cached) return cached.models;
    throw err instanceof Error ? err : new Error(String(err));
  }
}
