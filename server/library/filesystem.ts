import fs from "node:fs/promises";
import fscb from "node:fs";
import path from "node:path";

export type ImportMode = "auto" | "hardlink" | "copy" | "move";

export async function sameDevice(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
    return sa.dev === sb.dev;
  } catch {
    return false;
  }
}

export async function freeSpace(dir: string): Promise<number> {
  const stat = await fs.statfs(dir);
  return stat.bavail * stat.bsize;
}

/**
 * Create `dir` (and any missing ancestors) and return the list of directories
 * that were actually created, leaf-first. Used so ownership/permissions can be
 * applied only to the dirs we made, not to pre-existing library folders.
 */
export async function mkdirp(dir: string): Promise<string[]> {
  const first = await fs.mkdir(dir, { recursive: true });
  if (!first) return [];
  // `first` is the topmost newly-created dir; everything from it down to `dir` is new.
  const created: string[] = [];
  let cur = dir;
  for (;;) {
    created.push(cur);
    if (cur === first) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return created;
}

async function streamCopy(src: string, dest: string): Promise<void> {
  const tmp = `${dest}.partial~`;
  await new Promise<void>((resolve, reject) => {
    const read = fscb.createReadStream(src);
    const write = fscb.createWriteStream(tmp);
    read.on("error", reject);
    write.on("error", reject);
    write.on("finish", resolve);
    read.pipe(write);
  });
  // Flush to disk and verify the whole file landed before we rename into place —
  // move mode deletes the source afterwards, so this must be trustworthy.
  try {
    const fh = await fs.open(tmp, "r+");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    const [srcStat, tmpStat] = await Promise.all([fs.stat(src), fs.stat(tmp)]);
    if (tmpStat.size !== srcStat.size) {
      throw new Error(
        `Copy size mismatch for ${dest}: ${tmpStat.size} != ${srcStat.size} bytes`
      );
    }
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  await fs.rename(tmp, dest);
}

export interface PlaceFileResult {
  method: "hardlink" | "copy" | "move";
}

/**
 * Place `src` at `dest` according to `mode`:
 *   - auto:     hardlink when src and dest share a filesystem, else copy.
 *   - hardlink: hardlink; on failure fall back to a copy (never fail the import
 *               just because hardlinking is impossible across shares).
 *   - copy:     always stream-copy via a temp name and rename into place.
 *   - move:     rename when same-device; otherwise copy-to-temp, fsync + verify
 *               size, rename into place, and only THEN delete the source.
 * Returns the method actually used.
 */
export async function placeFile(
  src: string,
  dest: string,
  mode: ImportMode = "auto"
): Promise<PlaceFileResult> {
  const destDir = path.dirname(dest);
  await fs.mkdir(destDir, { recursive: true });

  const resolved: Exclude<ImportMode, "auto"> =
    mode === "auto" ? ((await sameDevice(src, destDir)) ? "hardlink" : "copy") : mode;

  if (resolved === "hardlink") {
    try {
      await fs.link(src, dest);
      return { method: "hardlink" };
    } catch (err) {
      console.warn(
        `[import] hardlink failed for ${dest}, copying instead:`,
        err instanceof Error ? err.message : err
      );
      await streamCopy(src, dest);
      return { method: "copy" };
    }
  }

  if (resolved === "move") {
    if (await sameDevice(src, destDir)) {
      await fs.rename(src, dest);
      return { method: "move" };
    }
    // Cross-device: copy fully into place and size-verify BEFORE removing source.
    await streamCopy(src, dest);
    await fs.rm(src, { force: true });
    return { method: "move" };
  }

  // copy
  await streamCopy(src, dest);
  return { method: "copy" };
}

function envInt(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// Unraid convention: nobody:users == 99:100. Files 0664, dirs 0775.
const PUID = envInt("PUID", 99);
const PGID = envInt("PGID", 100);
const FILE_MODE = 0o664;
const DIR_MODE = 0o775;

/**
 * Best-effort: set ownership/permissions on a freshly-placed file and any dirs
 * we created for it, so a container running as root hands media to PUID:PGID.
 * Silently skipped on non-Linux (macOS dev EPERMs on chown 99) and whenever it
 * fails (non-root) — a permissions failure must never fail an import.
 */
export async function applyOwnership(filePath: string, createdDirs: string[] = []): Promise<void> {
  if (process.platform !== "linux") return;
  try {
    await fs.chown(filePath, PUID, PGID).catch(() => {});
    await fs.chmod(filePath, FILE_MODE).catch(() => {});
    for (const dir of createdDirs) {
      await fs.chown(dir, PUID, PGID).catch(() => {});
      await fs.chmod(dir, DIR_MODE).catch(() => {});
    }
  } catch {
    // best-effort only
  }
}
