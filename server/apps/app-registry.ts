import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CONFIG_DIR } from "@/server/config/paths";

/**
 * Installable app builds the server hands out itself, so a phone or TV can get
 * the app from the same box that holds the library instead of from a store.
 *
 * Builds live as opaque `<id>.<ext>` files in one directory with a JSON catalog
 * beside them. Naming the file after its id rather than anything user-supplied
 * means no upload can ever choose where it lands; the human-facing name is
 * rebuilt from catalog fields at download time.
 */

export type AppPlatform = "android" | "ios";

export interface AppBuild {
  /** Opaque id — also the on-disk filename stem. */
  id: string;
  platform: AppPlatform;
  /** Marketing version, as the uploader labelled it (e.g. "1.0.0"). */
  version: string;
  sizeBytes: number;
  sha256: string;
  /** ISO timestamp. */
  uploadedAt: string;
  /**
   * iOS only, and required there: the itms-services manifest has to advertise
   * the IPA's real bundle identifier or the install fails with no useful error.
   */
  bundleId?: string;
  /** Free-text note from the uploader, e.g. which devices an ad-hoc build covers. */
  notes?: string;
}

const APPS_DIR = path.join(CONFIG_DIR, "apps");
const CATALOG_PATH = path.join(APPS_DIR, "catalog.json");

/** File extension per platform. Also the only extensions ever written. */
export const BUILD_EXTENSIONS: Record<AppPlatform, string> = { android: ".apk", ios: ".ipa" };

/** Refuse anything larger — a guard against a stray upload filling /config. */
export const MAX_BUILD_BYTES = 512 * 1024 * 1024;

export class BuildTooLargeError extends Error {
  constructor() {
    super(`Build exceeds the ${Math.round(MAX_BUILD_BYTES / 1024 / 1024)} MB limit`);
    this.name = "BuildTooLargeError";
  }
}

function ensureAppsDir(): void {
  fs.mkdirSync(APPS_DIR, { recursive: true });
}

/** The catalog, or an empty list when it is missing or unreadable. A corrupt
 *  catalog must not take the whole settings page down with it. */
function readCatalog(): AppBuild[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as AppBuild[]) : [];
  } catch {
    return [];
  }
}

function writeCatalog(builds: AppBuild[]): void {
  ensureAppsDir();
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(builds, null, 2));
}

/** Every build, newest upload first. */
export function listBuilds(): AppBuild[] {
  return readCatalog().sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export function getBuild(id: string): AppBuild | undefined {
  return readCatalog().find((b) => b.id === id);
}

/** The build a fresh install should get for a platform: the newest upload. */
export function latestBuild(platform: AppPlatform): AppBuild | undefined {
  return listBuilds().find((b) => b.platform === platform);
}

export function buildPath(build: AppBuild): string {
  return path.join(APPS_DIR, `${build.id}${BUILD_EXTENSIONS[build.platform]}`);
}

/**
 * The name the download is offered under. Built from catalog fields and stripped
 * of anything that isn't plainly safe in a filename, so a `Content-Disposition`
 * header can never be split or escaped by what someone typed as a version.
 */
export function downloadFileName(build: AppBuild): string {
  const version = build.version.replace(/[^A-Za-z0-9._-]/g, "") || "unversioned";
  return `media-box-${version}-${build.platform}${BUILD_EXTENSIONS[build.platform]}`;
}

/**
 * Stream an uploaded build to disk, hashing and measuring as it goes so nothing
 * is ever buffered whole. A failed or oversized upload leaves no partial file
 * and no catalog entry.
 */
export async function saveBuild(
  meta: { platform: AppPlatform; version: string; bundleId?: string; notes?: string },
  body: ReadableStream<Uint8Array>
): Promise<AppBuild> {
  ensureAppsDir();
  const id = crypto.randomBytes(8).toString("hex");
  const abs = path.join(APPS_DIR, `${id}${BUILD_EXTENSIONS[meta.platform]}`);
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;

  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      sizeBytes += chunk.length;
      if (sizeBytes > MAX_BUILD_BYTES) {
        done(new BuildTooLargeError());
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });

  try {
    const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(source, meter, fs.createWriteStream(abs));
  } catch (err) {
    fs.rmSync(abs, { force: true });
    throw err;
  }

  const build: AppBuild = {
    id,
    platform: meta.platform,
    version: meta.version,
    sizeBytes,
    sha256: hash.digest("hex"),
    uploadedAt: new Date().toISOString(),
    ...(meta.bundleId ? { bundleId: meta.bundleId } : {}),
    ...(meta.notes ? { notes: meta.notes } : {}),
  };
  writeCatalog([...readCatalog(), build]);
  return build;
}

/** Forget a build and delete its file. Idempotent. */
export function deleteBuild(id: string): void {
  const builds = readCatalog();
  const build = builds.find((b) => b.id === id);
  if (!build) return;
  writeCatalog(builds.filter((b) => b.id !== id));
  fs.rmSync(buildPath(build), { force: true });
}
