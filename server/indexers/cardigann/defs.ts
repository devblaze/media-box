import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR } from "@/server/config/paths";

/**
 * Fetching + caching of Cardigann YAML definitions from the Prowlarr/Indexers
 * GitHub repo. The YAMLs are GPL so they are never vendored into media-box —
 * we fetch them at runtime and cache under CONFIG_DIR so restarts (and GitHub
 * outages) don't leave the catalog empty: stale cache always beats no data.
 */

const CACHE_DIR = path.join(CONFIG_DIR, "cardigann-defs");
const INDEX_FILE = path.join(CACHE_DIR, "index.json");
const TTL_MS = 24 * 60 * 60 * 1000;
const UA = "media-box/0.1";

const GITHUB_CONTENTS = "https://api.github.com/repos/Prowlarr/Indexers/contents/definitions";

export interface DefIndexEntry {
  /** Definition id = YAML filename without extension (matches its `id:`). */
  id: string;
  downloadUrl: string;
}

interface DefIndexFile {
  fetchedAt: string;
  /** Schema directory the index came from, e.g. "v11". */
  version: string;
  entries: DefIndexEntry[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": UA, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub responded ${res.status} for ${url}`);
  return (await res.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`responded ${res.status} for ${url}`);
  return await res.text();
}

interface GithubDirEntry {
  name: string;
  type: string;
  download_url: string | null;
}

/** Fetch the repo's newest definitions/vN directory listing. */
async function fetchRemoteIndex(): Promise<DefIndexFile> {
  const dirs = await fetchJson<GithubDirEntry[]>(GITHUB_CONTENTS);
  // Multiple schema versions coexist (v1..vN); the newest has the most defs
  // and is what current Prowlarr reads.
  const versions = dirs
    .filter((d) => d.type === "dir" && /^v\d+$/.test(d.name))
    .map((d) => Number(d.name.slice(1)));
  if (versions.length === 0) throw new Error("no definitions directories found upstream");
  const version = `v${Math.max(...versions)}`;
  const files = await fetchJson<GithubDirEntry[]>(`${GITHUB_CONTENTS}/${version}`);
  const entries: DefIndexEntry[] = files
    .filter((f) => f.type === "file" && f.name.endsWith(".yml") && f.download_url)
    .map((f) => ({ id: f.name.replace(/\.yml$/, ""), downloadUrl: f.download_url as string }));
  return { fetchedAt: new Date().toISOString(), version, entries };
}

async function readIndexCache(): Promise<DefIndexFile | null> {
  try {
    const raw = await fs.readFile(INDEX_FILE, "utf8");
    const parsed = JSON.parse(raw) as DefIndexFile;
    return Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

let memoIndex: { at: number; index: DefIndexFile } | null = null;

/**
 * The list of available definitions (id + raw URL), served from a 24h cache.
 * Network failures fall back to any cached copy regardless of age.
 */
export async function getDefinitionIndex(): Promise<DefIndexEntry[]> {
  if (memoIndex && Date.now() - memoIndex.at < TTL_MS) return memoIndex.index.entries;
  const cached = await readIndexCache();
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < TTL_MS) {
    memoIndex = { at: Date.now(), index: cached };
    return cached.entries;
  }
  try {
    const fresh = await fetchRemoteIndex();
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(INDEX_FILE, JSON.stringify(fresh, null, 2), "utf8");
    memoIndex = { at: Date.now(), index: fresh };
    return fresh.entries;
  } catch (err) {
    if (cached) {
      // Serve stale on failure — an out-of-date catalog beats an empty one.
      memoIndex = { at: Date.now(), index: cached };
      return cached.entries;
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function defCachePath(id: string): string {
  // ids come from upstream filenames, but never trust them as path segments.
  return path.join(CACHE_DIR, `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.yml`);
}

/**
 * Raw YAML for one definition, cached on disk with the same TTL/stale rules.
 */
export async function getDefinitionYaml(id: string): Promise<string> {
  const file = defCachePath(id);
  let stale: string | null = null;
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    if (Date.now() - stat.mtimeMs < TTL_MS) return text;
    stale = text;
  } catch {
    // No cache yet.
  }
  const entries = await getDefinitionIndex();
  const entry = entries.find((e) => e.id === id);
  if (!entry) {
    if (stale !== null) return stale;
    throw new Error(`Unknown Cardigann definition '${id}'`);
  }
  try {
    const text = await fetchText(entry.downloadUrl);
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(file, text, "utf8");
    return text;
  } catch (err) {
    if (stale !== null) return stale;
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Warm the cache for every definition in the index, a few at a time. Used by
 * the catalog listing; raw.githubusercontent tolerates this fine as long as
 * we keep concurrency modest and hit the disk cache on subsequent calls.
 */
export async function fetchAllDefinitions(
  concurrency = 8
): Promise<{ id: string; yaml: string | null }[]> {
  const entries = await getDefinitionIndex();
  const results: { id: string; yaml: string | null }[] = new Array(entries.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < entries.length) {
      const i = next++;
      try {
        results[i] = { id: entries[i].id, yaml: await getDefinitionYaml(entries[i].id) };
      } catch {
        // One broken def must not sink the whole catalog.
        results[i] = { id: entries[i].id, yaml: null };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return results;
}
