import { describe, it, expect } from "vitest";
import { evaluate, matchesTerm, type EvaluationContext, type ProfileLike, type ReleaseCandidate } from "./scoring";
import { parseTitle } from "./release-parser";
import { QUALITIES } from "./quality";

const ALL_ALLOWED: ProfileLike["items"] = QUALITIES.filter((q) => q.id !== 0).map((q) => ({
  qualityId: q.id,
  allowed: true,
}));

function candidate(title: string, seeders = 100): ReleaseCandidate {
  return {
    guid: title,
    indexerId: 1,
    indexerName: "test",
    title,
    size: 1_000_000_000,
    seeders,
    leechers: 0,
    downloadUrl: "http://example/download",
    parsed: parseTitle(title),
  };
}

function movieCtx(profile: Partial<ProfileLike>): EvaluationContext {
  return {
    profile: { cutoffQualityId: 7, upgradeAllowed: true, items: ALL_ALLOWED, ...profile },
    targetTitles: ["The Matrix"],
    targetYear: 1999,
    mediaType: "movie",
  };
}

describe("matchesTerm", () => {
  it("does case-insensitive substring matching", () => {
    expect(matchesTerm("The.Matrix.1999.1080p.BluRay.x264-YIFY", "yify")).toBe(true);
    expect(matchesTerm("The.Matrix.1999.1080p.BluRay-RARBG", "yify")).toBe(false);
  });

  it("treats a /slash-wrapped/ term as a case-insensitive regex", () => {
    expect(matchesTerm("Show.S01E01.720p", "/720p|1080p/")).toBe(true);
    expect(matchesTerm("Show.S01E01.480p", "/720p|1080p/")).toBe(false);
  });

  it("never throws on an invalid regex", () => {
    expect(matchesTerm("anything", "/(/")).toBe(false);
  });
});

describe("evaluate() release-term preferences", () => {
  it("prefers a matching group by score but still accepts others (automatic fallback)", () => {
    const opts = { preferredTerms: [{ term: "YIFY", score: 50 }] };
    const yify = evaluate(candidate("The.Matrix.1999.1080p.BluRay.x264-YIFY"), movieCtx(opts));
    const rarbg = evaluate(candidate("The.Matrix.1999.1080p.BluRay.x264-RARBG"), movieCtx(opts));

    expect(yify.accepted).toBe(true);
    expect(rarbg.accepted).toBe(true); // non-preferred is still eligible -> fallback
    expect(yify.score).toBeGreaterThan(rarbg.score); // preferred wins at equal quality
  });

  it("rejects a release containing an ignored term", () => {
    const e = evaluate(candidate("The.Matrix.1999.1080p.CAM.x264"), movieCtx({ ignoredTerms: ["CAM"] }));
    expect(e.accepted).toBe(false);
    expect(e.rejections.join(" ")).toContain("ignored");
  });

  it("requires at least one required term when set", () => {
    const missing = evaluate(
      candidate("The.Matrix.1999.1080p.BluRay-RARBG"),
      movieCtx({ requiredTerms: ["YIFY"] })
    );
    expect(missing.accepted).toBe(false);

    const present = evaluate(
      candidate("The.Matrix.1999.1080p.BluRay-YIFY"),
      movieCtx({ requiredTerms: ["YIFY"] })
    );
    expect(present.accepted).toBe(true);
  });

  it("has no effect when no terms are configured (backwards compatible)", () => {
    const withEmpty = evaluate(candidate("The.Matrix.1999.1080p.BluRay-YIFY"), movieCtx({}));
    const scoreNoTerms = withEmpty.score;
    expect(withEmpty.accepted).toBe(true);
    expect(Number.isFinite(scoreNoTerms)).toBe(true);
  });
});
