#!/usr/bin/env node
// Renders the mobile app's icons from the web app's icon (app/icon.svg), so the
// phone shows the same mark as the browser tab. Run from the repo root after
// changing app/icon.svg:
//
//   node apps/mobile/scripts/make-icons.mjs
//
// Uses `sharp` from the web app's node_modules (it renders SVG with librsvg).
// The SVG has to keep its shape: a <defs> with the gradient, one background
// <rect fill="url(#bg)">, then the play-screen mark.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const out = path.resolve(here, "..", "assets", "images");

const src = fs.readFileSync(path.join(root, "app", "icon.svg"), "utf8");
const defs = src.match(/<defs>[\s\S]*?<\/defs>/)?.[0];
const background = src.match(/<rect[^>]*fill="url\(#bg\)"[^>]*\/>/)?.[0];
if (!defs || !background) throw new Error("app/icon.svg no longer has the <defs> + background <rect> this expects.");
const mark = src.slice(src.indexOf("</defs>") + "</defs>".length, src.lastIndexOf("</svg>")).replace(background, "");

const svg = (body) =>
  `<svg width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">${defs}${body}</svg>`;
// Android shows the middle 72dp of an adaptive icon's 108dp canvas; drawing the
// artwork at that scale makes the visible part match the iOS icon.
const ADAPTIVE = 72 / 108;
const adaptive = (body) => `<g transform="translate(256 256) scale(${ADAPTIVE}) translate(-256 -256)">${body}</g>`;

const icons = [
  // iOS masks its own corners and rejects transparency, so: square, full bleed, opaque.
  { file: "icon.png", size: 1024, opaque: true, svg: svg(`<rect width="512" height="512" fill="url(#bg)"/>${mark}`) },
  { file: "android-icon-background.png", size: 1024, opaque: true,
    svg: svg(adaptive(`<rect x="-512" y="-512" width="1536" height="1536" fill="url(#bg)"/>`)) },
  { file: "android-icon-foreground.png", size: 1024, svg: svg(adaptive(mark)) },
  // Themed icons: Android tints this one shape, so drop the tinted screen fill.
  { file: "android-icon-monochrome.png", size: 1024,
    svg: svg(adaptive(mark.replace(/<rect[^>]*fill-opacity[^>]*\/>/, ""))) },
  // On the splash and the web export the icon stands alone, so keep its own corners.
  { file: "splash-icon.png", size: 1024, svg: src },
  { file: "favicon.png", size: 48, svg: src },
];

for (const icon of icons) {
  let image = sharp(Buffer.from(icon.svg), { density: (72 * icon.size) / 512 }).resize(icon.size, icon.size);
  if (icon.opaque) image = image.flatten({ background: "#F97316" }).removeAlpha();
  await image.png().toFile(path.join(out, icon.file));
  console.log(`${icon.file} ${icon.size}×${icon.size}`);
}
