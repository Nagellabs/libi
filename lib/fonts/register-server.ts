/**
 * Register libi's bundled 2D fonts with `@napi-rs/canvas`.
 *
 * SERVER-ONLY. The browser and the headless render page get the same faces via
 * `@font-face` (see `lib/fonts/bundled.ts`); this is the third renderer —
 * node-canvas — used by storyboard sketch rendering, tracking verify renders,
 * and the overflow/font analysis in `app/api/render/frames/route.ts`.
 *
 * Without this, `GlobalFonts.has("Inter")` is false and every draw silently
 * falls back to a default face at a DIFFERENT width, so server-side text
 * measurement disagrees with what preview and export actually draw.
 *
 * ── DELIBERATELY IMPORTS NOTHING FROM `lib/logger` ─────────────────────────
 * One caller — `lib/storyboard/render/canvas.ts` — runs agent-authored draw
 * functions inside a Node PERMISSION-MODEL sandbox (`--allow-fs-write` scoped
 * to a temp dir). `lib/logger.ts` calls `ensureLibiDirs()` at MODULE SCOPE,
 * which is an `mkdirSync` into `~/.libi`; under that sandbox it throws
 * `ERR_ACCESS_DENIED` while the module graph is still loading, killing the
 * render subprocess before any draw code runs and defeating the isolation
 * backstop that `__tests__/integration/storyboard/render-isolation.test.ts`
 * guards. So the logger is `require`d lazily, only on the missing-file branch
 * that a healthy install never reaches. This is a correctness constraint, not
 * a bundle-size optimisation — do not "clean it up" into a static import.
 */

import path from "node:path";
import fs from "node:fs";
import { GlobalFonts } from "@napi-rs/canvas";
import { BUNDLED_FONTS } from "./bundled";

let registered = false;

/** Absolute on-disk path to a bundled 2D font file. */
export function bundledFontFilePath(file: string): string {
  return path.join(process.cwd(), "public", "fonts", "2d", file);
}

/**
 * Idempotently register every bundled face. Safe to call on any code path that
 * is about to measure or draw text with `@napi-rs/canvas`; the first call does
 * the work and the rest are free.
 *
 * A missing file is logged and skipped rather than thrown: losing one weight
 * should degrade that weight, not take down a render. `notices:check` already
 * hard-fails on a missing font file, so this path should be unreachable in a
 * released build.
 */
export function ensureBundledFontsRegistered(): void {
  if (registered) return;
  registered = true;


  const missing: string[] = [];

  for (const face of BUNDLED_FONTS) {
    const filePath = bundledFontFilePath(face.file);
    if (!fs.existsSync(filePath)) {
      missing.push(face.file);
      continue;
    }
    // Pass the family explicitly so registration never depends on the name
    // table inside the file agreeing with what overlays ask for.
    GlobalFonts.registerFromPath(filePath, face.family);
  }

  if (missing.length > 0) warnMissing(missing);
}

/**
 * Lazily load the logger and report missing faces. Split out so the logger's
 * module-scope `ensureLibiDirs()` never runs on the happy path — see the
 * sandbox note at the top of this file.
 */
function warnMissing(missing: string[]): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { serverLogger } = require("@/lib/logger") as typeof import("@/lib/logger");
    serverLogger
      .child({ tag: "fonts", op: "register_server" })
      .warn({ missing }, "bundled font files are missing — text will fall back to a system face");
  } catch {
    // Loading the logger can itself fail under the storyboard sandbox. A
    // missing font is already a degraded state; it must not also take down
    // the render.
  }
}

/** Test seam: forget that registration ran. */
export function resetBundledFontRegistrationForTests(): void {
  registered = false;
}
