/**
 * Escaping for values placed inside an ffmpeg filtergraph (`-vf` /
 * `-filter_complex`). Dependency-free on purpose: the export backend, the
 * tracking annotator and the dev fakes all build drawtext filters, and the
 * export's overlay-filter module pulls in @napi-rs/canvas.
 */

/**
 * Make `raw` a literal filter-option value inside a filtergraph (`-vf` /
 * `-filter_complex`). Two parsers read it in turn:
 *   1. the filtergraph parser strips one level of quoting — inside '…'
 *      nothing is special, not even a backslash, so a `'` can only be
 *      written by closing the quote, escaping it, and reopening: `'\''`;
 *   2. the option parser splits on ':' and strips one level of backslash
 *      escaping — so `\`, `'` and `:` are backslash-escaped for it.
 * Escaping for only one of them is the bug this replaces: a one-level `\:`
 * was eaten by (1), the colon then split the option in (2), and every Windows
 * font path (`C:\…`) failed the whole export with "No option name near …".
 */
export function quoteFilterValue(raw: string): string {
  const forOptionParser = raw.replace(/[\\':]/g, (c) => `\\${c}`);
  return `'${forOptionParser.replace(/'/g, "'\\''")}'`;
}

/**
 * drawtext's own text expansion (the third reader of a `text=` value) treats
 * `\` as an escape and `%{…}` as a function call; escape both so the caption
 * is drawn verbatim. Pass the result through `quoteFilterValue`.
 */
export function escapeDrawtext(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/%/g, "\\%");
}
