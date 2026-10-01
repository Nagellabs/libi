/**
 * Path-traversal guard for a stored file NAME — one path segment inside a
 * piece's storage dir (`files.filename`, `proxyFilename`, `filmstripFilename`,
 * a route's `[filename]` / id param).
 *
 * The guard is per SEGMENT, not per substring. The old `name.includes("..")`
 * refused every name containing `...` — a downloaded TikTok title ending in
 * `...` became `…_....mp4`, and neither its proxy nor its original could be
 * served (proxy 400 → the editor's endless "Buffering…";
 * docs-local/qa/2026-09-25-video-download-and-playback-plan.md T1). `..` is only
 * dangerous as a whole segment, and a single-segment name has no separator, so
 * `...`, `a..b`, `.hidden` and `100%.png` are all ordinary names.
 *
 * Refused: a non-string or empty name, `.` and `..`, any `/` or `\`, and NUL.
 * The storage layer's lexical + realpath containment (`lib/storage/local.ts`)
 * remains the backstop behind this.
 *
 * Two entry points, by where the name came from:
 *   - `isUnsafeStorageName` — a name read from the DB (by-id routes). Judged
 *     RAW: it is the literal on-disk name, and `%` is a legal character in one
 *     (`storeFile` only basename()s, yt-dlp's --restrict-filenames keeps `%`).
 *   - `isUnsafeUrlParamName` — a name taken from a URL segment. Also refuses
 *     the Windows hazards (`isWindowsHazard`: `:`, a trailing `.` or space),
 *     and is also judged in its percent-decoded form, so a router that hands the param over still
 *     encoded (`..%2fx`, `%2e%2e`) gets the same answer as one that decodes it.
 *     Each well-formed `%XX` is decoded on its own; a malformed `%`
 *     (`50% off.mp4`) stays literal, so it neither refuses an ordinary name
 *     nor hides a traversal escape beside it (`..%2fx%`).
 */
export function isUnsafeStorageName(name: string): boolean {
  if (typeof name !== "string") return true;
  return isUnsafeSegment(name);
}

export function isUnsafeUrlParamName(name: string): boolean {
  if (isUnsafeStorageName(name) || isWindowsHazard(name)) return true;
  if (!name.includes("%")) return false;
  // Decode each well-formed `%XX` escape on its own and leave a malformed `%`
  // literal. decodeURIComponent would throw on the WHOLE name for one bad
  // escape (`..%2fx%`), and judging it raw then would wave the well-formed
  // traversal escapes beside it through.
  const decoded = name.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  if (decoded === name) return false;
  // Also judge it with any `%` left over removed: `%2e%2e%` decodes to `..%`,
  // one segment on its own, but a lenient downstream decoder that drops the
  // stray `%` would see `..`. No real URL-supplied name needs that shape.
  return (
    isUnsafeSegment(decoded) ||
    isWindowsHazard(decoded) ||
    isUnsafeSegment(decoded.replace(/%/g, "")) ||
    isWindowsHazard(decoded.replace(/%/g, ""))
  );
}

/**
 * Names Windows reads as something other than a file in the piece folder, refused for a
 * URL-supplied name and for agent-written path segments (a storyboard card's `render.file`,
 * lib/storyboard/repo.ts): a `:` (an alternate data stream, `clip.mp4:secret`, or a
 * drive-relative `C:x`), and a trailing `.` or space, which Windows strips — `clip.mp4.` would
 * open `clip.mp4`, and `....` the folder itself. No name libi writes has either shape, and a
 * DB-sourced name is still judged raw (it is the literal on-disk name).
 */
export function isWindowsHazard(name: string): boolean {
  return name.includes(":") || name.endsWith(".") || name.endsWith(" ");
}

function isUnsafeSegment(name: string): boolean {
  return (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  );
}
