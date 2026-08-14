/**
 * Pure helpers for custom-font handling. NO DOM, NO fs — unit-tested in
 * isolation and safe to import from both client and server bundles.
 */

/** A deterministic, CSS-identifier-safe family name for an uploaded font file. */
export function cssFamilyForFontFile(fileId: string): string {
  return `libifont-${fileId}`;
}

/**
 * Split a CSS font shorthand into the size/weight prefix and the family list.
 * Matches the leading `... <size>px` run as the prefix; the rest is the family.
 * Returns null when no `<n>px` size token is present.
 */
export function parseFontShorthand(
  font: string,
): { prefix: string; family: string } | null {
  const m = font.match(/^(.*?\d+(?:\.\d+)?px)\s+(.+)$/);
  if (!m) return null;
  return { prefix: m[1].trim(), family: m[2].trim() };
}

/**
 * Replace the family in a CSS font shorthand with `family` (adding a
 * `, sans-serif` fallback), preserving the size/weight prefix. Returns the
 * original string unchanged when the shorthand has no parseable size.
 */
export function withFamily(font: string, family: string): string {
  const parsed = parseFontShorthand(font);
  if (!parsed) return font;
  return `${parsed.prefix} ${family}, sans-serif`;
}
