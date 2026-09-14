import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The registry resolves its directory from CONFIG_DIR at module load, so the
// mock has to be hoisted above the import — and a hoisted block runs before the
// imports it sits above, which is why this builds its path from globals only.
const { tmpRoot } = vi.hoisted(() => ({
  tmpRoot: `${(process.env.TMPDIR || "/tmp").replace(/\/$/, "")}/mediabox-apps-${process.pid}`,
}));
vi.mock("@/server/config/paths", () => ({ CONFIG_DIR: tmpRoot }));

import {
  deleteBuild,
  downloadFileName,
  getBuild,
  latestBuild,
  listBuilds,
  saveBuild,
  type AppBuild,
} from "./app-registry";

const APPS_DIR = path.join(tmpRoot, "apps");

/** A one-shot web stream, the shape a route hands over from `request.body`. */
function streamOf(data: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(data));
      controller.close();
    },
  });
}

beforeEach(() => {
  fs.rmSync(APPS_DIR, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(APPS_DIR, { recursive: true, force: true });
});

describe("saveBuild", () => {
  test("writes the file and records what was actually stored", async () => {
    const bytes = Buffer.from("not really an apk, but bytes all the same");
    const build = await saveBuild({ platform: "android", version: "1.2.3" }, streamOf(bytes));

    expect(build.sizeBytes).toBe(bytes.length);
    // The hash is measured while streaming, so it describes the stored file
    // rather than anything the uploader claimed about it.
    expect(build.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(path.join(APPS_DIR, `${build.id}.apk`))).toEqual(bytes);
    expect(getBuild(build.id)?.version).toBe("1.2.3");
  });

  test("names the file after its id, never after anything supplied", async () => {
    // The version is free text from an admin form; if it reached the filesystem
    // a path could be chosen by whoever typed it.
    const build = await saveBuild(
      { platform: "android", version: "../../escape" },
      streamOf(Buffer.from("x"))
    );
    expect(fs.readdirSync(APPS_DIR)).toContain(`${build.id}.apk`);
  });

  test("an iOS build keeps the bundle id the install manifest needs", async () => {
    const build = await saveBuild(
      { platform: "ios", version: "1.0.0", bundleId: "org.mediabox.app" },
      streamOf(Buffer.from("x"))
    );
    expect(build.bundleId).toBe("org.mediabox.app");
    expect(fs.existsSync(path.join(APPS_DIR, `${build.id}.ipa`))).toBe(true);
  });

  test("a failed upload leaves no partial file and no catalog entry", async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error("connection dropped"));
      },
    });
    await expect(saveBuild({ platform: "android", version: "1.0.0" }, failing)).rejects.toThrow();
    expect(listBuilds()).toEqual([]);
    // A half-written APK left on disk would be offered for download as if whole.
    expect(fs.existsSync(APPS_DIR) ? fs.readdirSync(APPS_DIR) : []).not.toContain(".apk");
  });
});

describe("listBuilds and latestBuild", () => {
  test("the newest upload for a platform is the one handed out", async () => {
    const older = await saveBuild({ platform: "android", version: "1.0.0" }, streamOf(Buffer.from("a")));
    await new Promise((r) => setTimeout(r, 5)); // distinct ISO timestamps
    const newer = await saveBuild({ platform: "android", version: "1.1.0" }, streamOf(Buffer.from("b")));
    await saveBuild({ platform: "ios", version: "0.9.0", bundleId: "x" }, streamOf(Buffer.from("c")));

    expect(latestBuild("android")?.id).toBe(newer.id);
    expect(latestBuild("ios")?.version).toBe("0.9.0");
    // Superseding a build does not remove it — an admin can still delete it or
    // re-point at it if the newer one turns out to be broken.
    expect(listBuilds().map((b) => b.id)).toContain(older.id);
  });

  test("no build for a platform is not an error", () => {
    expect(latestBuild("ios")).toBeUndefined();
    expect(listBuilds()).toEqual([]);
  });

  test("a corrupt catalog reads as empty rather than taking the page down", () => {
    fs.mkdirSync(APPS_DIR, { recursive: true });
    fs.writeFileSync(path.join(APPS_DIR, "catalog.json"), "{ this is not json");
    expect(listBuilds()).toEqual([]);
  });
});

describe("deleteBuild", () => {
  test("forgets the build and removes its file", async () => {
    const build = await saveBuild({ platform: "android", version: "1.0.0" }, streamOf(Buffer.from("a")));
    deleteBuild(build.id);
    expect(getBuild(build.id)).toBeUndefined();
    expect(fs.existsSync(path.join(APPS_DIR, `${build.id}.apk`))).toBe(false);
  });

  test("deleting something already gone is not an error", () => {
    expect(() => deleteBuild("never-existed")).not.toThrow();
  });
});

describe("downloadFileName", () => {
  const build = (version: string, platform: AppBuild["platform"] = "android"): AppBuild => ({
    id: "abc",
    platform,
    version,
    sizeBytes: 1,
    sha256: "x",
    uploadedAt: "2026-01-01T00:00:00.000Z",
  });

  test("reads as the app and its version", () => {
    expect(downloadFileName(build("1.2.3"))).toBe("media-box-1.2.3-android.apk");
    expect(downloadFileName(build("1.0.0", "ios"))).toBe("media-box-1.0.0-ios.ipa");
  });

  test("strips anything that could break out of the header it lands in", () => {
    // This string is interpolated into Content-Disposition; a quote or newline
    // there is a header-splitting bug, not a cosmetic one.
    expect(downloadFileName(build('1.0" ; drop\r\nX: y'))).toBe("media-box-1.0dropXy-android.apk");
    expect(downloadFileName(build("../../etc/passwd"))).toBe("media-box-....etcpasswd-android.apk");
  });

  test("a version of nothing usable still yields a filename", () => {
    expect(downloadFileName(build("???"))).toBe("media-box-unversioned-android.apk");
  });
});
