#!/usr/bin/env node
/**
 * Checks the one local-environment fault that has repeatedly made this repo look
 * broken: iCloud evicting `node_modules`.
 *
 * When the checkout sits in an iCloud-synced folder (~/Documents, ~/Desktop),
 * macOS reclaims space by turning files into **dataless placeholders**. They
 * still `stat` at full size, but the first read blocks until iCloud fetches them
 * back. Every `require()` then waits on the network: `eslint` went from 6 seconds
 * to over ten minutes, `tsc` likewise, and a partially-materialised read can even
 * surface as "X is not a constructor" from a truncated dependency.
 *
 * A dataless file reports 0 allocated blocks for a non-zero size, which is what
 * this samples for. Reinstalling is the fastest repair — pulling the files back
 * from iCloud is far slower than fetching them from the package cache.
 *
 *   yarn doctor
 */
import { statSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const NODE_MODULES = path.join(ROOT, "node_modules");
const SAMPLE_SIZE = 400;

/** Breadth-first walk that stops once it has enough files to judge by. */
function sampleFiles(root, limit) {
  const found = [];
  const queue = [root];
  while (queue.length > 0 && found.length < limit) {
    const dir = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= limit) break;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(abs);
      else if (entry.isFile() && /\.(js|cjs|mjs|json)$/.test(entry.name)) found.push(abs);
    }
  }
  return found;
}

function main() {
  try {
    statSync(NODE_MODULES);
  } catch {
    console.error("node_modules is missing — run `yarn install --frozen-lockfile`.");
    process.exit(1);
  }

  const files = sampleFiles(NODE_MODULES, SAMPLE_SIZE);
  if (files.length === 0) {
    console.error("node_modules looks empty — run `yarn install --frozen-lockfile`.");
    process.exit(1);
  }

  let dataless = 0;
  for (const file of files) {
    try {
      const s = statSync(file);
      // size > 0 with nothing allocated on disk = an iCloud placeholder.
      if (s.size > 0 && s.blocks === 0) dataless++;
    } catch {
      // A file that vanished mid-walk tells us nothing either way.
    }
  }

  const pct = Math.round((dataless / files.length) * 100);
  if (dataless === 0) {
    console.log(`node_modules: ${files.length} files sampled, all present locally. ✓`);
    return;
  }

  console.error(
    `node_modules: ${dataless} of ${files.length} sampled files (${pct}%) are iCloud ` +
      `placeholders — reading them blocks on a download.\n` +
      `\nThis is why lint/typecheck/build crawl. Repair by reinstalling (much faster\n` +
      `than waiting for iCloud to hand the files back):\n` +
      `\n    rm -rf node_modules && yarn install --frozen-lockfile\n` +
      `\nTo stop it recurring, move this checkout out of the iCloud-synced folder, or\n` +
      `turn off System Settings → Apple Account → iCloud → iCloud Drive →\n` +
      `"Optimise Mac Storage". See the macOS section of AGENTS.md.`
  );
  process.exit(1);
}

main();
