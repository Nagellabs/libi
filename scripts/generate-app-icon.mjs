#!/usr/bin/env node
/**
 * Generate the desktop app icon from the brand mark.
 *
 * Source of truth for the mark's geometry is `components/brand/libi-mark.tsx`
 * (two circles, viewBox 0 0 32 32) and the brand primary from
 * `app/globals.css` (`--primary: #6b8a6b`) on the editor's dark background
 * (`#09090b`, the same value the Electron windows use for `backgroundColor`).
 * If either changes, re-run this script — the outputs are committed binaries.
 *
 * Outputs (all under build/, which electron-builder auto-detects):
 *   build/icon.png   1024×1024 — Linux targets + the dev dock icon
 *   build/icon.icns  macOS multi-size (via iconutil, macOS only)
 *
 * Windows: electron-builder derives the .ico from icon.png automatically; a
 * hand-tuned build/icon.ico can be added later if small sizes look muddy.
 *
 * Rasterised with @resvg/resvg-js (already a production dependency) so there
 * is no new tooling; the iconset step shells out to sips + iconutil, which
 * ship with macOS.
 */
import { Resvg } from "@resvg/resvg-js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "build");

// macOS icon grid: the artwork sits on a ~824/1024 rounded rectangle with
// transparent margins; ~22.5% corner radius approximates Apple's squircle.
const CANVAS = 1024;
const PLATE = 824;
const PLATE_XY = (CANVAS - PLATE) / 2; // 100
const RADIUS = Math.round(PLATE * 0.225); // 185

// The mark from libi-mark.tsx, placed by its optical bounds: stroke circle
// (cx 12, cy 16, r 8, sw 2) spans x 3–21 / y 7–25; filled circle (cx 20,
// cy 16, r 3.2) extends x to 23.2. Optical center (13.1, 16), width 20.2.
const MARK_SCALE = 23; // 20.2 units × 23 ≈ 465 px ≈ 56% of the plate
const TX = CANVAS / 2 - 13.1 * MARK_SCALE;
const TY = CANVAS / 2 - 16 * MARK_SCALE;

const BG = "#09090b";
const PRIMARY = "#6b8a6b";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <rect x="${PLATE_XY}" y="${PLATE_XY}" width="${PLATE}" height="${PLATE}" rx="${RADIUS}" fill="${BG}"/>
  <g transform="translate(${TX} ${TY}) scale(${MARK_SCALE})" stroke="none">
    <circle cx="12" cy="16" r="8" fill="none" stroke="${PRIMARY}" stroke-width="2"/>
    <circle cx="20" cy="16" r="3.2" fill="${PRIMARY}"/>
  </g>
</svg>`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const png = new Resvg(svg, { fitTo: { mode: "width", value: CANVAS } }).render().asPng();
const pngPath = path.join(OUT_DIR, "icon.png");
fs.writeFileSync(pngPath, png);
console.log(`[app-icon] wrote ${path.relative(ROOT, pngPath)} (${png.length} bytes)`);

if (process.platform !== "darwin") {
  console.log("[app-icon] not macOS — skipping icon.icns (needs sips + iconutil)");
  process.exit(0);
}

const iconset = fs.mkdtempSync(path.join(os.tmpdir(), "libi-iconset-")) + "/icon.iconset";
fs.mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  execFileSync("sips", ["-z", String(size), String(size), pngPath, "--out", `${iconset}/icon_${size}x${size}.png`], { stdio: "pipe" });
  const retina = size * 2;
  execFileSync("sips", ["-z", String(retina), String(retina), pngPath, "--out", `${iconset}/icon_${size}x${size}@2x.png`], { stdio: "pipe" });
}
const icnsPath = path.join(OUT_DIR, "icon.icns");
execFileSync("iconutil", ["-c", "icns", iconset, "-o", icnsPath]);
fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
console.log(`[app-icon] wrote ${path.relative(ROOT, icnsPath)} (${fs.statSync(icnsPath).size} bytes)`);
