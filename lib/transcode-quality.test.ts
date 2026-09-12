/**
 * media-box encodes ONE rendition per session, so the rung has to be picked up
 * front from a measured link speed — and picked conservatively, because getting
 * it wrong means a restart mid-film. These cover the pure ladder helpers the
 * player menu and the ffmpeg args both read from.
 */
import { describe, expect, test } from "vitest";
import {
  DEFAULT_TRANSCODE_QUALITY,
  LOWEST_TRANSCODE_QUALITY,
  STEP_UP_LINK_FRACTION,
  TRANSCODE_QUALITIES,
  USABLE_LINK_FRACTION,
  canStepUpTo,
  formatKbps,
  higherQuality,
  linkCanCarry,
  lowerQuality,
  qualityForLinkKbps,
  qualityRank,
  qualityTotalKbps,
  transcodeQuality,
} from "./transcode-quality";

describe("transcodeQuality", () => {
  test("resolves a known rung id", () => {
    expect(transcodeQuality("medium").height).toBe(720);
    expect(transcodeQuality("minimal").id).toBe("minimal");
  });

  test("unknown or absent ids fall back to the top rung", () => {
    // A stale client (or a hand-rolled request) must not break playback.
    expect(transcodeQuality("ultra")).toBe(DEFAULT_TRANSCODE_QUALITY);
    expect(transcodeQuality("")).toBe(DEFAULT_TRANSCODE_QUALITY);
    expect(transcodeQuality(null)).toBe(DEFAULT_TRANSCODE_QUALITY);
    expect(transcodeQuality(undefined)).toBe(DEFAULT_TRANSCODE_QUALITY);
  });
});

describe("qualityTotalKbps", () => {
  test("sums video and audio — what the link actually has to carry", () => {
    expect(qualityTotalKbps(transcodeQuality("max"))).toBe(8160); // 8000 + 160
    expect(qualityTotalKbps(transcodeQuality("minimal"))).toBe(564); // 500 + 64
  });
});

describe("qualityRank", () => {
  test("0 is the best rung, the ladder descends, unknown ids are -1", () => {
    expect(qualityRank("max")).toBe(0);
    expect(qualityRank("high")).toBe(1);
    expect(qualityRank("minimal")).toBe(TRANSCODE_QUALITIES.length - 1);
    expect(qualityRank("ultra")).toBe(-1);
  });
});

describe("lowerQuality", () => {
  test("steps one rung down the ladder", () => {
    expect(lowerQuality("max")?.id).toBe("high");
    expect(lowerQuality("medium")?.id).toBe("low");
  });

  test("the bottom rung has nowhere to go", () => {
    // What the player uses to stop retrying a stall it can't encode its way out of.
    expect(lowerQuality(LOWEST_TRANSCODE_QUALITY.id)).toBeNull();
  });

  test("an unknown id drops to the second rung rather than nothing", () => {
    expect(lowerQuality("ultra")?.id).toBe(TRANSCODE_QUALITIES[1].id);
  });
});

describe("higherQuality", () => {
  test("steps one rung up the ladder", () => {
    expect(higherQuality("minimal")?.id).toBe("low");
    expect(higherQuality("high")?.id).toBe("max");
  });

  test("the top rung has nowhere to go, and an unknown id goes nowhere either", () => {
    expect(higherQuality(DEFAULT_TRANSCODE_QUALITY.id)).toBeNull();
    expect(higherQuality("ultra")).toBeNull();
  });
});

describe("canStepUpTo", () => {
  const medium = transcodeQuality("medium"); // 2128 kbps total

  test("needs more headroom than merely staying put would", () => {
    // The gap between the two fractions IS the hysteresis: a link that can carry
    // a rung is not yet a link auto will climb to it.
    const justCarries = qualityTotalKbps(medium) / USABLE_LINK_FRACTION;
    expect(linkCanCarry(qualityTotalKbps(medium), justCarries)).toBe(true);
    expect(canStepUpTo(medium, justCarries)).toBe(false);

    const comfortable = qualityTotalKbps(medium) / STEP_UP_LINK_FRACTION;
    expect(canStepUpTo(medium, comfortable)).toBe(true);
  });

  test("an unmeasured link never justifies stepping up", () => {
    // Unlike linkCanCarry, where "unknown" means don't interfere.
    expect(canStepUpTo(medium, null)).toBe(false);
    expect(canStepUpTo(medium, 0)).toBe(false);
  });
});

describe("linkCanCarry", () => {
  test("an unmeasured link never blocks a rung", () => {
    // No probe result → keep today's behaviour instead of guessing downward.
    expect(linkCanCarry(8160, null)).toBe(true);
    expect(linkCanCarry(8160, 0)).toBe(true);
    expect(linkCanCarry(8160, -1)).toBe(true);
  });

  test("only the usable fraction of a measured link counts", () => {
    // 10 Mbps measured → 7 Mbps budget; the rest is headroom for the dips.
    expect(USABLE_LINK_FRACTION).toBe(0.7);
    expect(linkCanCarry(7000, 10_000)).toBe(true);
    expect(linkCanCarry(7001, 10_000)).toBe(false);
  });
});

describe("qualityForLinkKbps", () => {
  test("an unknown speed keeps the top rung", () => {
    expect(qualityForLinkKbps(null)).toBe(DEFAULT_TRANSCODE_QUALITY);
    expect(qualityForLinkKbps(0)).toBe(DEFAULT_TRANSCODE_QUALITY);
  });

  test("a fast link gets the top rung", () => {
    expect(qualityForLinkKbps(100_000).id).toBe("max");
    expect(qualityForLinkKbps(12_000).id).toBe("max"); // 8160 ≤ 0.7 · 12000
  });

  test("a middling link gets the best rung that fits the budget", () => {
    // 5 Mbps → 3.5 Mbps usable: "high" (4128) doesn't fit, "medium" (2128) does.
    expect(qualityForLinkKbps(5_000).id).toBe("medium");
    // 6 Mbps → 4.2 Mbps usable, enough for "high".
    expect(qualityForLinkKbps(6_000).id).toBe("high");
  });

  test("a link too slow for even the bottom rung still gets the bottom rung", () => {
    // Something playable beats nothing at all.
    expect(qualityForLinkKbps(100)).toBe(LOWEST_TRANSCODE_QUALITY);
  });
});

describe("formatKbps", () => {
  test("switches to Mbps at 1000 kbps, one decimal", () => {
    expect(formatKbps(6_400)).toBe("6.4 Mbps");
    expect(formatKbps(1_000)).toBe("1.0 Mbps");
  });

  test("sub-Mbps speeds stay whole kbps", () => {
    expect(formatKbps(820)).toBe("820 kbps");
    expect(formatKbps(820.4)).toBe("820 kbps");
    expect(formatKbps(999)).toBe("999 kbps");
  });
});
