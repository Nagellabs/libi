"use client";

/**
 * Force the bundled faces to actually DOWNLOAD in the browser.
 *
 * WHY THIS IS NEEDED even though `app/globals.css` declares every `@font-face`:
 * an `@font-face` rule is lazy. The browser fetches the file only when some
 * rendered DOM node needs it — and **a canvas never triggers that fetch**.
 * `ctx.font = "800 120px Inter"` on an unloaded face silently measures and
 * draws in a fallback, which is the exact silent-substitution bug
 * `lib/fonts/bundled.ts` exists to kill, reintroduced one layer down.
 *
 * Observed live in the running app (2026-08-18): after a fresh page load
 * `document.fonts` listed Inter 600, Inter 700 and JetBrains Mono 700 with
 * `status: "unloaded"`, and a canvas measurement of `800 120px Inter` returned
 * 1442.64px — byte-identical to a garbage family name. After an explicit
 * `document.fonts.load()` for each face, the same measurement returned
 * 1374.49px. Nothing in the DOM had used those weights yet, so nothing had
 * fetched them.
 *
 * `font-display: block` does NOT cover this. It governs how DOM text behaves
 * while a face loads; it has no bearing on a canvas draw that never asked for
 * the face in the first place.
 *
 * This mirrors what `lib/fonts/registry-client.ts` already does for UPLOADED
 * fonts (`new FontFace(...).load()`) — that path knew fonts must be loaded
 * explicitly; the bundled ones needed the same treatment.
 */

import { BUNDLED_FONTS } from "./bundled";

let inFlight: Promise<void> | null = null;

/**
 * Load every bundled face. Idempotent and cached — concurrent callers share
 * one promise, and later calls resolve immediately.
 *
 * Never rejects: a face that fails to load leaves that weight falling back,
 * which is a degraded render, not a reason to break the editor.
 */
export function ensureBundledFontsLoaded(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (typeof document === "undefined" || !document.fonts) return;
    await Promise.all(
      BUNDLED_FONTS.map(async (face) => {
        // Quote the family: "JetBrains Mono" is invalid in a font shorthand
        // unquoted, and document.fonts.load throws a SyntaxError on it.
        const shorthand = `${face.weight} 16px "${face.family}"`;
        try {
          await document.fonts.load(shorthand);
        } catch {
          // Degraded weight, not a broken app.
        }
      }),
    );
  })();
  return inFlight;
}

/** Test seam: forget that loading ran. */
export function resetBundledFontLoadingForTests(): void {
  inFlight = null;
}
