import { describe, expect, test } from "vitest";
import { DEFAULT_TRANSCODE_QUALITY, transcodeQuality } from "@/lib/transcode-quality";
import { buildFfmpegArgs, buildVodPlaylist, type Session } from "./session-manager";

/** Value following a flag in an argv array (fails the test if the flag is absent). */
function argAfter(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  expect(i, `expected flag ${flag} in ${args.join(" ")}`).toBeGreaterThanOrEqual(0);
  return args[i + 1];
}

describe("buildFfmpegArgs", () => {
  const ABS = "/media/movies/Film (2024)/film.mkv";
  const DIR = "/config/transcode/abc123";

  test("startSegment 0: no input seek, segments numbered from 0", () => {
    const args = buildFfmpegArgs(ABS, DIR, "none", "", 0);
    expect(args).not.toContain("-ss");
    expect(argAfter(args, "-start_number")).toBe("0");
    // Keyframe expression anchored at t=0.
    expect(argAfter(args, "-force_key_frames")).toBe("expr:gte(t,0+n_forced*4)");
  });

  test("startSegment 300: -ss 1200 before -i, absolute numbering and anchored keyframes", () => {
    const args = buildFfmpegArgs(ABS, DIR, "none", "", 300);
    expect(argAfter(args, "-ss")).toBe("1200"); // 300 segments x 4 s
    // The seek must be an INPUT option (before -i) for fast seeking.
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(argAfter(args, "-start_number")).toBe("300");
    expect(argAfter(args, "-force_key_frames")).toBe("expr:gte(t,1200+n_forced*4)");
    // Source timestamps preserved so runs share one absolute timeline.
    expect(args).toContain("-copyts");
  });

  test("negative startSegment is clamped to 0", () => {
    const args = buildFfmpegArgs(ABS, DIR, "none", "", -5);
    expect(args).not.toContain("-ss");
    expect(argAfter(args, "-start_number")).toBe("0");
  });

  test("HLS output args are sane (mode-independent)", () => {
    for (const mode of ["none", "nvenc"] as const) {
      const args = buildFfmpegArgs(ABS, DIR, mode, "", 0);
      expect(argAfter(args, "-f")).toBe("hls");
      expect(argAfter(args, "-hls_time")).toBe("4");
      expect(argAfter(args, "-hls_playlist_type")).toBe("event");
      expect(argAfter(args, "-hls_flags")).toBe("independent_segments+temp_file");
      expect(argAfter(args, "-hls_segment_type")).toBe("mpegts");
      expect(argAfter(args, "-hls_segment_filename")).toBe(`${DIR}/seg%05d.ts`);
      // Playlist path is the final argument.
      expect(args[args.length - 1]).toBe(`${DIR}/index.m3u8`);
      // Audio is always transcoded to stereo AAC; subtitles dropped.
      expect(argAfter(args, "-c:a")).toBe("aac");
      expect(argAfter(args, "-ac")).toBe("2");
      expect(args).toContain("-sn");
      expect(argAfter(args, "-i")).toBe(ABS);
    }
  });

  test('mode "none" encodes with libx264 and disables scene-cut keyframes', () => {
    const args = buildFfmpegArgs(ABS, DIR, "none", "", 0);
    expect(argAfter(args, "-c:v")).toBe("libx264");
    expect(argAfter(args, "-sc_threshold")).toBe("0");
    expect(argAfter(args, "-pix_fmt")).toBe("yuv420p");
    // Downscale-only filter; software encode needs no nv12 conversion.
    expect(argAfter(args, "-vf")).toBe("scale=-2:'min(1080,ih)'");
    // No hardware device flags in software mode.
    expect(args).not.toContain("-vaapi_device");
    expect(args).not.toContain("-qsv_device");
  });

  test('mode "nvenc" encodes with h264_nvenc after an nv12 convert, no device flags', () => {
    const args = buildFfmpegArgs(ABS, DIR, "nvenc", "/dev/dri/renderD128", 0);
    expect(argAfter(args, "-c:v")).toBe("h264_nvenc");
    expect(argAfter(args, "-preset")).toBe("p4");
    expect(argAfter(args, "-cq")).toBe("23");
    expect(argAfter(args, "-vf")).toBe("scale=-2:'min(1080,ih)',format=nv12");
    // NVENC selects its GPU internally — the DRM render node flags are VAAPI/QSV-only.
    expect(args).not.toContain("-vaapi_device");
    expect(args).not.toContain("-qsv_device");
  });

  test("audio track selection: default maps 0:a:0?, explicit index maps that stream", () => {
    const def = buildFfmpegArgs(ABS, DIR, "none", "", 0);
    expect(def).toContain("0:a:0?");
    const picked = buildFfmpegArgs(ABS, DIR, "none", "", 0, 2);
    expect(picked).toContain("0:a:2?");
    expect(picked).not.toContain("0:a:0?");
    // Invalid (negative / non-integer) indices fall back to track 0.
    expect(buildFfmpegArgs(ABS, DIR, "none", "", 0, -1)).toContain("0:a:0?");
    expect(buildFfmpegArgs(ABS, DIR, "none", "", 0, 1.5)).toContain("0:a:0?");
  });

  // ---- bitrate rungs (lib/transcode-quality) ----

  /** The constant-quality flag each hardware encoder uses on the top rung. */
  const HW_CONSTANT_QUALITY = [
    ["vaapi", "-qp"],
    ["qsv", "-global_quality"],
    ["nvenc", "-cq"],
  ] as const;

  test("no rung given: the software encode is exactly the pre-ladder one", () => {
    const args = buildFfmpegArgs(ABS, DIR, "none", "", 0);
    // Capped CRF at the generous LAN settings, 1080p ceiling, 160k audio.
    expect(argAfter(args, "-crf")).toBe("21");
    expect(argAfter(args, "-maxrate")).toBe("8000k");
    expect(argAfter(args, "-bufsize")).toBe("16000k");
    expect(argAfter(args, "-vf")).toBe("scale=-2:'min(1080,ih)'");
    expect(argAfter(args, "-b:a")).toBe("160k");
  });

  test("a lower rung caps the picture as well as the bitrate", () => {
    const medium = transcodeQuality("medium"); // 720p · 2 Mbps · 128k audio
    const args = buildFfmpegArgs(ABS, DIR, "none", "", 0, undefined, medium);
    // Fewer pixels is what makes a small bitrate watchable.
    expect(argAfter(args, "-vf")).toBe(`scale=-2:'min(${medium.height},ih)'`);
    expect(argAfter(args, "-maxrate")).toBe(`${medium.videoKbps}k`);
    expect(argAfter(args, "-bufsize")).toBe(`${medium.videoKbps * 2}k`); // 2 s of VBV
    // Below the top rung the encode trades quality for fitting the budget.
    expect(argAfter(args, "-crf")).toBe("23");
    expect(argAfter(args, "-b:a")).toBe(`${medium.audioKbps}k`);
  });

  test("hardware top rung: constant quality, no explicit bitrate", () => {
    for (const [mode, cqFlag] of HW_CONSTANT_QUALITY) {
      const args = buildFfmpegArgs(ABS, DIR, mode, "/dev/dri/renderD128", 0);
      expect(argAfter(args, cqFlag)).toBe("23");
      expect(args, `${mode} should not target a bitrate`).not.toContain("-b:v");
    }
  });

  test("hardware lower rung: an explicit bitrate replaces constant quality", () => {
    const low = transcodeQuality("low"); // 480p · 1 Mbps
    for (const [mode, cqFlag] of HW_CONSTANT_QUALITY) {
      const args = buildFfmpegArgs(ABS, DIR, mode, "/dev/dri/renderD128", 0, undefined, low);
      expect(argAfter(args, "-b:v")).toBe(`${low.videoKbps}k`);
      expect(argAfter(args, "-maxrate")).toBe(`${low.videoKbps}k`);
      expect(argAfter(args, "-bufsize")).toBe(`${low.videoKbps * 2}k`);
      // "Roughly this good" is no use when the budget is 1 Mbps.
      expect(args, `${mode} should drop ${cqFlag}`).not.toContain(cqFlag);
    }
    // Each encoder needs its own rate-control mode switched to bitrate-targeted.
    const vaapi = buildFfmpegArgs(ABS, DIR, "vaapi", "/dev/dri/renderD128", 0, undefined, low);
    expect(argAfter(vaapi, "-rc_mode")).toBe("VBR");
    const nvenc = buildFfmpegArgs(ABS, DIR, "nvenc", "", 0, undefined, low);
    expect(argAfter(nvenc, "-rc")).toBe("vbr");
  });

  test("the rung leaves the rest of the argv alone", () => {
    const minimal = transcodeQuality("minimal");
    const args = buildFfmpegArgs(ABS, DIR, "none", "", 300, 2, minimal);
    // Segment numbering, keyframe anchoring and audio mapping are rung-independent.
    expect(argAfter(args, "-start_number")).toBe("300");
    expect(argAfter(args, "-force_key_frames")).toBe("expr:gte(t,1200+n_forced*4)");
    expect(args).toContain("0:a:2?");
    expect(argAfter(args, "-hls_time")).toBe("4");
    expect(argAfter(args, "-hls_playlist_type")).toBe("event");
    expect(argAfter(args, "-hls_flags")).toBe("independent_segments+temp_file");
    expect(argAfter(args, "-hls_segment_type")).toBe("mpegts");
    expect(args[args.length - 1]).toBe(`${DIR}/index.m3u8`);
  });
});

describe("buildVodPlaylist", () => {
  const makeSession = (over: Partial<Session>): Session => ({
    id: "s1",
    absPath: "/media/x.mkv",
    dir: "/config/transcode/s1",
    proc: null,
    status: "running",
    lastAccess: 0,
    durationSec: 0,
    segmentCount: 0,
    audioTrack: null,
    encoderStart: 0,
    quality: DEFAULT_TRANSCODE_QUALITY,
    ...over,
  });

  test("full VOD structure with the whole runtime listed up front", () => {
    // 10 s runtime → ceil(10/4) = 3 segments; last one is 10 − 2·4 = 2 s.
    const text = buildVodPlaylist(makeSession({ durationSec: 10, segmentCount: 3 }));
    const lines = text.split("\n");
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines).toContain("#EXT-X-VERSION:3");
    expect(lines).toContain("#EXT-X-TARGETDURATION:4");
    expect(lines).toContain("#EXT-X-MEDIA-SEQUENCE:0");
    expect(lines).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(lines).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    // Ends with ENDLIST and a trailing newline.
    expect(text.endsWith("#EXT-X-ENDLIST\n")).toBe(true);

    const extinfs = lines.filter((l) => l.startsWith("#EXTINF:"));
    const segs = lines.filter((l) => /^seg\d{5}\.ts$/.test(l));
    expect(extinfs).toEqual(["#EXTINF:4.000,", "#EXTINF:4.000,", "#EXTINF:2.000,"]);
    expect(segs).toEqual(["seg00000.ts", "seg00001.ts", "seg00002.ts"]);
    // Each EXTINF line immediately precedes its segment name.
    expect(lines[lines.indexOf("seg00000.ts") - 1]).toBe("#EXTINF:4.000,");
  });

  test("segment count drives the listing; last EXTINF is durationSec − (n−1)·4", () => {
    const text = buildVodPlaylist(makeSession({ durationSec: 61.5, segmentCount: 16 }));
    const lines = text.split("\n");
    const segs = lines.filter((l) => /^seg\d{5}\.ts$/.test(l));
    expect(segs).toHaveLength(16);
    expect(segs[0]).toBe("seg00000.ts");
    expect(segs[15]).toBe("seg00015.ts");
    const extinfs = lines.filter((l) => l.startsWith("#EXTINF:"));
    expect(extinfs[14]).toBe("#EXTINF:4.000,");
    expect(extinfs[15]).toBe("#EXTINF:1.500,"); // 61.5 − 15·4
  });

  test("last segment length is floored at 0.1 s", () => {
    // Duration exactly on a boundary but with an extra listed segment → the
    // remainder would be ≤ 0; the playlist must still advertise ≥ 0.1 s.
    const text = buildVodPlaylist(makeSession({ durationSec: 8, segmentCount: 3 }));
    const extinfs = text.split("\n").filter((l) => l.startsWith("#EXTINF:"));
    expect(extinfs[2]).toBe("#EXTINF:0.100,");
  });

  test("unknown duration (0 segments) still yields a valid empty VOD playlist", () => {
    const text = buildVodPlaylist(makeSession({ durationSec: 0, segmentCount: 0 }));
    expect(text).not.toContain("#EXTINF");
    expect(text).not.toContain(".ts");
    expect(text.split("\n")[0]).toBe("#EXTM3U");
    expect(text.endsWith("#EXT-X-ENDLIST\n")).toBe(true);
  });
});

/**
 * The playlist a SEEKABLE session serves always spans the whole runtime from
 * segment 0 — even when ffmpeg was started mid-film (`startSec`). That makes the
 * player's timeline ABSOLUTE media time, which is why clients must not add
 * `startSec` as a base offset (the `seekable` flag on POST /transcode tells
 * them which timeline they got). Regression guard for a resume bug where the
 * offset was double-counted.
 */
describe("seekable playlists are absolute, regardless of where ffmpeg started", () => {
  const session = {
    id: "s2",
    absPath: "/media/x.mkv",
    dir: "/config/transcode/s2",
    proc: null,
    status: "running" as const,
    lastAccess: 0,
    durationSec: 6215,
    segmentCount: Math.ceil(6215 / 4),
    audioTrack: null,
    // ffmpeg was started 20 minutes in…
    encoderStart: 300,
    quality: DEFAULT_TRANSCODE_QUALITY,
  };

  test("…but the playlist still starts at segment 0 and lists the whole film", () => {
    const lines = buildVodPlaylist(session).split("\n");
    const segs = lines.filter((l) => /^seg\d{5}\.ts$/.test(l));
    expect(segs[0]).toBe("seg00000.ts");
    expect(segs).toHaveLength(session.segmentCount);
    expect(segs[300]).toBe("seg00300.ts"); // the encoder's start is just another segment
  });
});
