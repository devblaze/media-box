import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFfmpegArgs } from "./session-manager";

const outputDir = path.join("tmp", "transcode-session");

describe("buildFfmpegArgs", () => {
  it("transcodes incompatible video and maps the requested audio track", () => {
    const args = buildFfmpegArgs("episode.mkv", outputDir, "none", "", 12.5, 1);

    expect(args).toContain("libx264");
    expect(args).toContain("expr:gte(t,n_forced*4)");
    expect(args).toContain("0:a:1?");
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2)).toEqual(["-ss", "12.5"]);
    expect(args).toContain("independent_segments+temp_file");
    expect(args).toContain("aresample=async=1000:first_pts=0");
  });

  it("direct-streams compatible H.264 while still converting audio", () => {
    const args = buildFfmpegArgs("dual-audio.mp4", outputDir, "none", "", undefined, 0, true);

    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual(["-c:v", "copy"]);
    expect(args).not.toContain("libx264");
    expect(args).not.toContain("-force_key_frames");
    expect(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2)).toEqual(["-c:a", "aac"]);
  });
});
