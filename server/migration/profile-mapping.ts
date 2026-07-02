import { QUALITIES, type ProfileItem } from "@/server/parser/quality";
import type { ArrProfileItem, ArrQualityProfile } from "./arr-client";

// Sonarr/Radarr quality ids we don't model, folded into the nearest neighbor.
const FOLD: Record<number, number | null> = {
  10: 1, // Raw-HD -> SDTV (rare)
  20: 7, // Bluray-1080p Remux -> Bluray-1080p (Radarr 30 is 2160 remux)
  30: 19, // Remux-2160p -> Bluray-2160p
  21: 19, // (Sonarr Bluray-2160p Remux)
  22: 7, // (Sonarr Bluray-1080p Remux)
  31: null, // BR-DISK -> dropped
};

const KNOWN_IDS = new Set(QUALITIES.map((q) => q.id));

export interface MappedProfile {
  name: string;
  upgradeAllowed: boolean;
  cutoffQualityId: number;
  items: ProfileItem[];
  notes: string[];
}

function flattenAllowedIds(items: ArrProfileItem[]): { id: number; allowed: boolean }[] {
  const out: { id: number; allowed: boolean }[] = [];
  for (const item of items) {
    if (item.quality) {
      out.push({ id: item.quality.id, allowed: item.allowed });
    } else if (item.items) {
      // group: every member inherits the group's allowed flag
      for (const member of item.items) {
        if (member.quality) out.push({ id: member.quality.id, allowed: item.allowed });
      }
    }
  }
  return out;
}

function resolveGroupCutoff(profile: ArrQualityProfile): number {
  // cutoff may reference a group id; use the group's best member
  for (const item of profile.items) {
    if (!item.quality && item.id === profile.cutoff && item.items) {
      const members = item.items.filter((m) => m.quality).map((m) => m.quality!.id);
      if (members.length > 0) return members[members.length - 1];
    }
  }
  return profile.cutoff;
}

export function mapProfile(profile: ArrQualityProfile): MappedProfile {
  const notes: string[] = [];
  const flat = flattenAllowedIds(profile.items);

  const allowedById = new Map<number, boolean>();
  for (const { id, allowed } of flat) {
    let mapped: number | null = id;
    if (!KNOWN_IDS.has(id)) {
      mapped = FOLD[id] ?? null;
      if (mapped === null) {
        if (allowed) notes.push(`Quality id ${id} has no equivalent and was dropped`);
        continue;
      }
      if (allowed) {
        notes.push(`Quality id ${id} folded into ${QUALITIES.find((q) => q.id === mapped)?.name}`);
      }
    }
    // if any source entry allows a quality, allow it here
    allowedById.set(mapped, (allowedById.get(mapped) ?? false) || allowed);
  }

  const items: ProfileItem[] = [...QUALITIES]
    .sort((a, b) => a.rank - b.rank)
    .filter((q) => q.id !== 0)
    .map((q) => ({ qualityId: q.id, allowed: allowedById.get(q.id) ?? false }));

  let cutoff = resolveGroupCutoff(profile);
  if (!KNOWN_IDS.has(cutoff)) cutoff = FOLD[cutoff] ?? 7;
  if (!items.some((i) => i.qualityId === cutoff && i.allowed)) {
    // fall back to the best allowed quality
    const bestAllowed = [...items].reverse().find((i) => i.allowed);
    if (bestAllowed) {
      cutoff = bestAllowed.qualityId;
      notes.push("Cutoff adjusted to the best allowed quality");
    }
  }

  return {
    name: profile.name,
    upgradeAllowed: profile.upgradeAllowed,
    cutoffQualityId: cutoff,
    items,
    notes,
  };
}
