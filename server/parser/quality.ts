// Static quality ladder. Ids match Sonarr/Radarr's shared ids where the two
// agree, which keeps Phase 4 profile migration a near-identity mapping.

export type QualitySource = "unknown" | "sdtv" | "dvd" | "hdtv" | "webrip" | "webdl" | "bluray";
export type Resolution = 0 | 480 | 720 | 1080 | 2160;

export interface QualityDefinition {
  id: number;
  name: string;
  source: QualitySource;
  resolution: Resolution;
  rank: number; // global default ordering, worst -> best
}

export interface QualityModel {
  qualityId: number;
  revision: { version: number; real: number };
}

export const QUALITIES: QualityDefinition[] = [
  { id: 0, name: "Unknown", source: "unknown", resolution: 0, rank: 0 },
  { id: 1, name: "SDTV", source: "sdtv", resolution: 480, rank: 1 },
  { id: 2, name: "DVD", source: "dvd", resolution: 480, rank: 2 },
  { id: 8, name: "WEBRip-480p", source: "webrip", resolution: 480, rank: 3 },
  { id: 12, name: "WEB-DL-480p", source: "webdl", resolution: 480, rank: 4 },
  { id: 4, name: "HDTV-720p", source: "hdtv", resolution: 720, rank: 5 },
  { id: 14, name: "WEBRip-720p", source: "webrip", resolution: 720, rank: 6 },
  { id: 5, name: "WEB-DL-720p", source: "webdl", resolution: 720, rank: 7 },
  { id: 6, name: "Bluray-720p", source: "bluray", resolution: 720, rank: 8 },
  { id: 9, name: "HDTV-1080p", source: "hdtv", resolution: 1080, rank: 9 },
  { id: 15, name: "WEBRip-1080p", source: "webrip", resolution: 1080, rank: 10 },
  { id: 3, name: "WEB-DL-1080p", source: "webdl", resolution: 1080, rank: 11 },
  { id: 7, name: "Bluray-1080p", source: "bluray", resolution: 1080, rank: 12 },
  { id: 16, name: "HDTV-2160p", source: "hdtv", resolution: 2160, rank: 13 },
  { id: 17, name: "WEBRip-2160p", source: "webrip", resolution: 2160, rank: 14 },
  { id: 18, name: "WEB-DL-2160p", source: "webdl", resolution: 2160, rank: 15 },
  { id: 19, name: "Bluray-2160p", source: "bluray", resolution: 2160, rank: 16 },
];

const byId = new Map(QUALITIES.map((q) => [q.id, q]));

export function getQuality(id: number): QualityDefinition {
  return byId.get(id) ?? QUALITIES[0];
}

export function qualityName(model: QualityModel | null | undefined): string {
  if (!model) return "Unknown";
  const base = getQuality(model.qualityId).name;
  return model.revision.version > 1 ? `${base} Proper` : base;
}

export interface ProfileItem {
  qualityId: number;
  allowed: boolean;
}

// Default profile item lists, ordered worst -> best.
export function defaultProfileItems(allowedIds: number[]): ProfileItem[] {
  const allowed = new Set(allowedIds);
  return [...QUALITIES]
    .sort((a, b) => a.rank - b.rank)
    .filter((q) => q.id !== 0)
    .map((q) => ({ qualityId: q.id, allowed: allowed.has(q.id) }));
}

export const DEFAULT_PROFILES = [
  {
    name: "HD-1080p",
    cutoffQualityId: 7, // Bluray-1080p
    items: defaultProfileItems([9, 15, 3, 7]),
  },
  {
    name: "Ultra-HD",
    cutoffQualityId: 19, // Bluray-2160p
    items: defaultProfileItems([16, 17, 18, 19]),
  },
  {
    name: "Any",
    cutoffQualityId: 7,
    items: defaultProfileItems(QUALITIES.filter((q) => q.id !== 0).map((q) => q.id)),
  },
];
