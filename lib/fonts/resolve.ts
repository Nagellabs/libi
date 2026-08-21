/**
 * Server-side truth for whether a font FAMILY will actually render, as opposed
 * to silently falling back to a different face — the bug `lib/fonts/bundled.ts`
 * documents at length (a whole 42-second piece rendered in a serif fallback
 * because it asked for "Inter", and nothing reported it for twenty hours).
 *
 * SERVER-ONLY: transitively imports `register-server.ts`, which imports
 * `node:fs`. Do not import this from a client bundle.
 */

import { GlobalFonts } from "@napi-rs/canvas";
import { isBundledFamily } from "./bundled";
import { ensureBundledFontsRegistered } from "./register-server";
import { parseFontShorthand } from "./family";

/**
 * Generic CSS keywords are not family names — the renderer resolves them
 * itself to whatever the platform's default is. Flagging them as "unresolved"
 * would make the warning fire on nearly every overlay that doesn't name a
 * specific family, and a noisy warning gets ignored, which defeats the
 * feature this module exists for.
 *
 * Exported because it was being hand-copied: the onboarding extractor and its
 * consistency test each grew their own near-identical list, and three copies of
 * a set like this drift silently — a family added here but missed there turns
 * a legitimate fallback into a hard failure in one place and not the others.
 * Lowercase throughout; compare with `.toLowerCase()`.
 */
export const GENERIC_CSS_FAMILIES = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "system-ui",
  "cursive",
  "fantasy",
  "ui-sans-serif",
  "ui-monospace",
  "ui-serif",
  "ui-rounded",
  "inherit",
  "initial",
]);

/** Strip a single layer of matching quotes, if present. */
function stripQuotes(family: string): string {
  if (family.length >= 2) {
    const first = family[0];
    const last = family[family.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return family.slice(1, -1);
    }
  }
  return family;
}

/**
 * Pull the family out of a CSS font shorthand — the first family of a
 * comma-separated list, quotes stripped. Returns `null` when `font` has no
 * parseable `<n>px` size (i.e. it isn't shorthand at all).
 */
export function familyFromFont(font: string): string | null {
  // Defensive: `font` is typed as a required string, but this is called from
  // `saveManifest` on whatever a manifest actually holds on disk — a bad or
  // missing value must not throw and take the whole save down with it.
  if (typeof font !== "string" || font.length === 0) return null;
  const parsed = parseFontShorthand(font);
  if (!parsed) return null;
  const first = parsed.family.split(",")[0]?.trim() ?? "";
  return stripQuotes(first);
}

/**
 * True when `family` will actually render as itself: a generic CSS keyword,
 * one of libi's bundled families, or a family this machine's `@napi-rs/canvas`
 * already knows about (a system font or one registered by an upload). False
 * means a draw naming this family silently substitutes a fallback face.
 */
export function isFamilyAvailable(family: string): boolean {
  const trimmed = family.trim();
  if (GENERIC_CSS_FAMILIES.has(trimmed.toLowerCase())) return true;
  if (isBundledFamily(trimmed)) return true;
  // A cold process hasn't registered the bundled faces yet — without this,
  // bundled families would report as missing on the very first check.
  ensureBundledFontsRegistered();
  return GlobalFonts.has(trimmed);
}

/**
 * The distinct families among `fonts` that will NOT resolve, in first-seen
 * order. Entries with no parseable family (see `familyFromFont`) are skipped
 * rather than flagged — there is nothing actionable to report.
 */
export function unresolvedFamilies(fonts: readonly string[]): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const font of fonts) {
    const family = familyFromFont(font);
    if (!family || seen.has(family)) continue;
    if (isFamilyAvailable(family)) continue;
    seen.add(family);
    missing.push(family);
  }
  return missing;
}
