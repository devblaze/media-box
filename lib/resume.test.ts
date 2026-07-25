import { describe, expect, it } from "vitest";
import { resumeStartSeconds } from "./resume";

describe("resumeStartSeconds", () => {
  it("starts from the top without saved progress", () => {
    expect(resumeStartSeconds(null)).toBe(0);
    expect(resumeStartSeconds(undefined)).toBe(0);
  });

  it("ignores blips of 5 seconds or less", () => {
    expect(resumeStartSeconds({ positionSeconds: 5, durationSeconds: 3600, watched: false })).toBe(0);
    expect(resumeStartSeconds({ positionSeconds: 3, durationSeconds: 0, watched: false })).toBe(0);
  });

  it("resumes at the saved position (floored)", () => {
    expect(resumeStartSeconds({ positionSeconds: 1234.9, durationSeconds: 3600, watched: false })).toBe(1234);
  });

  it("restarts near-finished titles instead of resuming into the credits", () => {
    expect(resumeStartSeconds({ positionSeconds: 3500, durationSeconds: 3600, watched: true })).toBe(0);
    // 94.99% is still resumable; 95% is not.
    expect(resumeStartSeconds({ positionSeconds: 3419, durationSeconds: 3600, watched: false })).toBe(3419);
    expect(resumeStartSeconds({ positionSeconds: 3420, durationSeconds: 3600, watched: false })).toBe(0);
  });

  it("resumes a rewatch (watched flag sticky, position low)", () => {
    expect(resumeStartSeconds({ positionSeconds: 600, durationSeconds: 3600, watched: true })).toBe(600);
  });

  it("trusts the position when the duration is unknown", () => {
    expect(resumeStartSeconds({ positionSeconds: 900, durationSeconds: 0, watched: false })).toBe(900);
  });
});
