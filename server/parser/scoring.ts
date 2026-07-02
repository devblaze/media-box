import { getQuality, type ProfileItem, type QualityModel } from "./quality";
import type { ParsedRelease } from "./release-parser";
import { normalizeTitle } from "@/server/library/naming-utils";

export interface ProfileLike {
  cutoffQualityId: number;
  upgradeAllowed: boolean;
  items: ProfileItem[];
  /** Preferred release terms; a match adds `score` to the release (negative to avoid). */
  preferredTerms?: { term: string; score: number }[];
  /** If any are set, a release must contain at least one of them. */
  requiredTerms?: string[];
  /** A release containing any of these is rejected. */
  ignoredTerms?: string[];
}

/**
 * Match a term against a release title. A term wrapped in slashes (e.g. `/x264/`)
 * is treated as a case-insensitive regex; otherwise it's a case-insensitive
 * substring match. Used for preferred/required/ignored release terms.
 */
export function matchesTerm(title: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  const re = t.match(/^\/(.+)\/$/);
  if (re) {
    try {
      return new RegExp(re[1], "i").test(title);
    } catch {
      return false; // invalid regex never matches
    }
  }
  return title.toLowerCase().includes(t.toLowerCase());
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

  // Release-term preferences (preferred groups, must/must-not contain).
  const ignored = ctx.profile.ignoredTerms ?? [];
  for (const term of ignored) {
    if (matchesTerm(release.title, term)) rejections.push(`Contains ignored term "${term}"`);
  }
  const required = ctx.profile.requiredTerms ?? [];
  if (required.length > 0 && !required.some((t) => matchesTerm(release.title, t))) {
    rejections.push(`Missing a required term (${required.join(", ")})`);
  }
  let preferredScore = 0;
  for (const p of ctx.profile.preferredTerms ?? []) {
    if (matchesTerm(release.title, p.term)) preferredScore += p.score;
  }

  const rank = Math.max(profileRank(ctx.profile, quality.qualityId), 0);
  // Preferred score sits between quality rank (×1000) and revision so a strong
  // preference can outrank quality if the user sets it high, but ties within a
  // quality tier are broken by preferred groups first. Non-preferred releases
  // remain accepted, so search falls back to them automatically.
  const score =
    rank * 1000 +
    preferredScore +
    quality.revision.version * 100 +
    Math.min(release.seeders ?? 0, 99);

  return { accepted: rejections.length === 0, rejections, score };
}
