import { getQuality, type ProfileItem, type QualityModel } from "./quality";
import type { ParsedRelease } from "./release-parser";
import { normalizeTitle } from "@/server/library/naming-utils";

export interface ProfileLike {
  cutoffQualityId: number;
  upgradeAllowed: boolean;
  items: ProfileItem[];
}

export interface ReleaseCandidate {
  guid: string;
  indexerId: number;
  indexerName: string;
  title: string;
  size: number;
  seeders: number | null;
  leechers: number | null;
  downloadUrl: string;
  magnetUrl?: string;
  infoHash?: string;
  publishDate?: string;
  parsed: ParsedRelease;
}

export interface EvaluationContext {
  profile: ProfileLike;
  /** normalized title(s) that identify the target (main title; aliases later) */
  targetTitles: string[];
  targetYear?: number | null;
  /** for series targets */
  seasonNumber?: number;
  episodeNumbers?: number[];
  allowSeasonPack?: boolean;
  /** current best file quality for upgrade decisions (null = missing) */
  currentQuality?: QualityModel | null;
  minimumSeeders?: number;
  isBlocklisted?: boolean;
  mediaType: "series" | "movie";
}

export interface Evaluation {
  accepted: boolean;
  rejections: string[];
  score: number;
}

// rank of a quality inside the profile's ordered item list (higher = better)
export function profileRank(profile: ProfileLike, qualityId: number): number {
  return profile.items.findIndex((i) => i.qualityId === qualityId);
}

export function isAllowed(profile: ProfileLike, qualityId: number): boolean {
  return profile.items.some((i) => i.qualityId === qualityId && i.allowed);
}

export function cutoffMet(profile: ProfileLike, current: QualityModel): boolean {
  return profileRank(profile, current.qualityId) >= profileRank(profile, profile.cutoffQualityId);
}

// candidate beats current: higher profile rank, or same quality with higher revision
export function isUpgrade(profile: ProfileLike, candidate: QualityModel, current: QualityModel): boolean {
  const cRank = profileRank(profile, candidate.qualityId);
  const curRank = profileRank(profile, current.qualityId);
  if (cRank > curRank) return true;
  if (cRank === curRank && candidate.revision.version > current.revision.version) return true;
  return false;
}

export function evaluate(release: ReleaseCandidate, ctx: EvaluationContext): Evaluation {
  const rejections: string[] = [];
  const parsed = release.parsed;
  const quality = parsed.quality;

  if (quality.qualityId === 0) rejections.push("Unknown quality");

  if (quality.qualityId !== 0 && !isAllowed(ctx.profile, quality.qualityId)) {
    rejections.push(`${getQuality(quality.qualityId).name} is not allowed by the quality profile`);
  }

  // title match
  const titleMatches = ctx.targetTitles.some((t) => normalizeTitle(t) === parsed.normalizedTitle);
  if (!titleMatches) {
    rejections.push(`Title '${parsed.title}' does not match`);
  }

  // year check for movies (when both known)
  if (ctx.mediaType === "movie" && ctx.targetYear && parsed.year && Math.abs(parsed.year - ctx.targetYear) > 1) {
    rejections.push(`Year ${parsed.year} does not match ${ctx.targetYear}`);
  }

  if (ctx.mediaType === "series") {
    if (!parsed.isTv) {
      rejections.push("Not a recognizable TV release");
    } else if (ctx.seasonNumber !== undefined) {
      if (!parsed.seasons.includes(ctx.seasonNumber)) {
        rejections.push(`Wrong season (wanted S${ctx.seasonNumber})`);
      } else if (parsed.episodes.length === 0) {
        // season pack
        if (!ctx.allowSeasonPack) rejections.push("Season pack not wanted here");
      } else if (
        ctx.episodeNumbers &&
        ctx.episodeNumbers.length > 0 &&
        !ctx.episodeNumbers.some((e) => parsed.episodes.includes(e))
      ) {
        rejections.push(`Wrong episode (wanted E${ctx.episodeNumbers.join("/E")})`);
      }
    }
  } else if (parsed.isTv) {
    rejections.push("TV release offered for a movie");
  }

  // upgrade logic
  if (ctx.currentQuality) {
    if (!isUpgrade(ctx.profile, quality, ctx.currentQuality)) {
      rejections.push("Not an upgrade over the existing file");
    } else if (!ctx.profile.upgradeAllowed && ctx.currentQuality.qualityId !== 0) {
      rejections.push("Upgrades are disabled in the quality profile");
    } else if (cutoffMet(ctx.profile, ctx.currentQuality)) {
      rejections.push("Profile cutoff already met");
    }
  }

  const minSeeders = ctx.minimumSeeders ?? 1;
  if (release.seeders !== null && release.seeders < minSeeders) {
    rejections.push(`Only ${release.seeders} seeder(s), minimum is ${minSeeders}`);
  }

  if (ctx.isBlocklisted) rejections.push("Release is blocklisted");

  const rank = Math.max(profileRank(ctx.profile, quality.qualityId), 0);
  const score =
    rank * 1000 + quality.revision.version * 100 + Math.min(release.seeders ?? 0, 99);

  return { accepted: rejections.length === 0, rejections, score };
}
