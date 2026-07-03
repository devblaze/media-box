// Shared HTTP client for Sonarr/Radarr v3 APIs.

export interface ArrConnection {
  url: string; // e.g. http://sonarr:8989
  apiKey: string;
}

export class ArrError extends Error {}

export async function arrGet<T>(conn: ArrConnection, path: string): Promise<T> {
  const base = conn.url.replace(/\/$/, "");
  const res = await fetch(`${base}/api/v3${path}`, {
    headers: { "X-Api-Key": conn.apiKey },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) throw new ArrError("Unauthorized — check the API key");
  if (!res.ok) throw new ArrError(`${path} responded ${res.status}`);
  return res.json() as Promise<T>;
}

export interface ArrSystemStatus {
  appName?: string;
  version: string;
  instanceName?: string;
}

export interface ArrQualityProfile {
  id: number;
  name: string;
  upgradeAllowed: boolean;
  cutoff: number;
  items: ArrProfileItem[];
}

export interface ArrProfileItem {
  quality?: { id: number; name: string };
  items?: ArrProfileItem[];
  allowed: boolean;
  id?: number; // group id
  name?: string; // group name
}

export interface ArrRootFolder {
  id: number;
  path: string;
}

export interface ArrTag {
  id: number;
  label: string;
}

export interface ArrIndexer {
  id: number;
  name: string;
  implementation: string;
  enableRss: boolean;
  enableAutomaticSearch: boolean;
  enableInteractiveSearch: boolean;
  priority: number;
  fields: { name: string; value?: unknown }[];
}

export interface ArrDownloadClient {
  id: number;
  name: string;
  implementation: string;
  enable: boolean;
  priority: number;
  fields: { name: string; value?: unknown }[];
}

export interface SonarrSeries {
  id: number;
  title: string;
  year: number;
  tvdbId: number;
  imdbId?: string;
  tmdbId?: number;
  path: string;
  rootFolderPath?: string;
  qualityProfileId: number;
  monitored: boolean;
  seasonFolder: boolean;
  seasons: { seasonNumber: number; monitored: boolean }[];
}

export interface RadarrMovie {
  id: number;
  title: string;
  year: number;
  tmdbId: number;
  imdbId?: string;
  path: string;
  rootFolderPath?: string;
  qualityProfileId: number;
  monitored: boolean;
  minimumAvailability: string;
}

export function fieldValue(fields: { name: string; value?: unknown }[], name: string): unknown {
  return fields.find((f) => f.name === name)?.value;
}
