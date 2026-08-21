/**
 * The 2D text fonts libi ships with itself.
 *
 * WHY THIS EXISTS: an agent authoring a text overlay or a canvas scene picks a
 * family by name, and a name that isn't installed fails SILENTLY — the canvas
 * substitutes a fallback face and `ctx.font` still reads back the string that
 * was set, so nothing anywhere reports a problem. A real 42-second piece was
 * built entirely in a serif fallback because it asked for "Inter", and the only
 * reason it surfaced was a human looking at a rendered frame twenty hours in.
 *
 * The fix is to make the obvious choice the correct one: bundle the families an
 * agent actually reaches for, and register them in every renderer. That also
 * makes text DETERMINISTIC across platforms — `Helvetica Neue` exists on macOS
 * and not on Linux or Windows, so relying on system fonts means a piece renders
 * differently depending on who opens it.
 *
 * Three renderers must agree, and each is registered differently:
 *   1. Preview (the app, a browser)      — `@font-face` in `app/globals.css`
 *   2. Export + composition frame render — `@font-face` in the headless render
 *      page (`app/render/route.ts`), which is Chromium, not node-canvas
 *   3. Storyboard sketches, tracking verify renders, and the overflow analysis
 *      in `app/api/render/frames/route.ts` — `@napi-rs/canvas` via
 *      `lib/fonts/register-server.ts`
 *
 * Licensing: both families are SIL OFL 1.1 and REMAIN so — they are not covered
 * by libi's GPL-3.0-only grant (OFL §5). Their license files ship beside them
 * under `public/fonts/2d/` as OFL §2 requires, and `THIRD-PARTY-NOTICES.md`
 * records them. `scripts/generate-third-party-notices.js` hashes this set, so
 * adding a font here without regenerating fails `notices:check`.
 *
 * NO node imports — this module is reachable from browser bundles (same
 * constraint as `lib/engine/text-3d/fonts.ts`, see the note there).
 */

export interface BundledFontFace {
  /** CSS family name, exactly as an overlay's `font` shorthand should name it. */
  family: string;
  /** CSS numeric weight this file provides. */
  weight: number;
  /** Filename under `public/fonts/2d/`. */
  file: string;
}

/**
 * Every weight is a SEPARATE static file on purpose. A requested weight with no
 * matching face is the same silent-substitution bug this module exists to
 * prevent, so the set covers the weights text overlays actually ask for rather
 * than the minimum that "works".
 */
export const BUNDLED_FONTS: readonly BundledFontFace[] = [
  { family: "Inter", weight: 400, file: "Inter-Regular.ttf" },
  { family: "Inter", weight: 600, file: "Inter-SemiBold.ttf" },
  { family: "Inter", weight: 700, file: "Inter-Bold.ttf" },
  { family: "Inter", weight: 800, file: "Inter-ExtraBold.ttf" },
  { family: "JetBrains Mono", weight: 400, file: "JetBrainsMono-Regular.ttf" },
  { family: "JetBrains Mono", weight: 700, file: "JetBrainsMono-Bold.ttf" },
];

/** Distinct families libi bundles, in preference order. */
export const BUNDLED_FONT_FAMILIES: readonly string[] = [
  ...new Set(BUNDLED_FONTS.map((f) => f.family)),
];

/** The default sans family — what an overlay gets when nothing is specified. */
export const DEFAULT_TEXT_FAMILY = "Inter";

/** The default monospace family — code overlays, terminal chips, `npx` lines. */
export const DEFAULT_MONO_FAMILY = "JetBrains Mono";

/** Web path for a bundled face. `public/` is served at the root. */
export function bundledFontUrl(file: string): string {
  return `/fonts/2d/${file}`;
}

/** True when `family` is one libi ships (case- and whitespace-insensitive). */
export function isBundledFamily(family: string): boolean {
  const needle = family.trim().toLowerCase();
  return BUNDLED_FONTS.some((f) => f.family.toLowerCase() === needle);
}

/**
 * `@font-face` rules for every bundled face.
 *
 * Emitted into BOTH `app/globals.css` (preview) and the headless render page
 * (`app/render/route.ts`). `globals.css` is static CSS and cannot import this
 * module, so its copy is checked against this registry by
 * `__tests__/unit/fonts/bundled-fonts.test.ts` rather than generated — if the
 * two ever drift, text renders one way in preview and another on export, which
 * is the exact class of bug this file exists to kill.
 *
 * `font-display: block` (not `swap`): a render pass that captures a frame
 * before the face loads would bake the fallback into the exported video.
 * Blocking is correct when the output is a file rather than a reading
 * experience.
 */
export function bundledFontFaceCss(): string {
  return BUNDLED_FONTS.map(
    (f) =>
      `@font-face{font-family:"${f.family}";src:url("${bundledFontUrl(f.file)}") format("truetype");` +
      `font-weight:${f.weight};font-style:normal;font-display:block;}`,
  ).join("\n");
}
