/**
 * What the hardware self-test tells you when it fails.
 *
 * This used to blame GPU passthrough for everything. On an Arc A380 that sent
 * someone hunting a passthrough problem they did not have: the card was mapped
 * in correctly and VAAPI was encoding fine, while QSV failed because Debian 12's
 * ffmpeg links Intel's Media SDK, which stops at 12th-generation integrated
 * graphics. Every string below is ffmpeg's own wording for a distinct fault, and
 * each needs a different thing done about it.
 */
import { describe, expect, test } from "vitest";
import { diagnoseHwFailure } from "./session-manager";

describe("diagnoseHwFailure", () => {
  test("an MFX session failure points at the ffmpeg build, not the GPU", () => {
    const msg = diagnoseHwFailure("qsv", "Error initializing an MFX session: unsupported (-3)");
    expect(msg).toMatch(/oneVPL/);
    expect(msg).toMatch(/VAAPI/); // the option that works on the same card today
    // The old advice was actively misleading here.
    expect(msg).not.toMatch(/passed through/i);
  });

  test("recognises the other spellings Intel's stack uses", () => {
    for (const stderr of [
      "[h264_qsv @ 0x55] Error initializing an internal MFX session",
      "Failed to create a VPL session",
      "libmfx: no suitable implementation found",
    ]) {
      expect(diagnoseHwFailure("qsv", stderr)).toMatch(/oneVPL/);
    }
  });

  test("a missing render node is a passthrough problem, and says so", () => {
    const msg = diagnoseHwFailure("vaapi", "Failed to open /dev/dri/renderD128: No such file or directory");
    expect(msg).toMatch(/passed into the container/);
  });

  test("no VA display is also a device problem", () => {
    const msg = diagnoseHwFailure("vaapi", "No VA display found for device: /dev/dri/renderD128.");
    expect(msg).toMatch(/passed into the container/);
  });

  test("permission denied beats the device wording, since the device is plainly there", () => {
    // This string matches the device pattern too. Getting the order wrong sends
    // someone to fix a mapping that is already correct.
    const msg = diagnoseHwFailure("vaapi", "Failed to open /dev/dri/renderD128: Permission denied");
    expect(msg).toMatch(/not allowed to open it/);
    expect(msg).not.toMatch(/passed into the container/);
  });

  test("an encoder missing from the build says that plainly", () => {
    expect(diagnoseHwFailure("nvenc", "Unknown encoder 'h264_nvenc'")).toMatch(/not available in this ffmpeg build/);
  });

  test("anything unrecognised still carries ffmpeg's own words", () => {
    const msg = diagnoseHwFailure("vaapi", "Something nobody has seen before");
    expect(msg).toContain("Something nobody has seen before");
  });

  test("names the mode that failed, so a test result is unambiguous", () => {
    expect(diagnoseHwFailure("qsv", "Error initializing an MFX session")).toMatch(/QSV/i);
    expect(diagnoseHwFailure("vaapi", "Permission denied")).toMatch(/VAAPI/i);
  });
});
