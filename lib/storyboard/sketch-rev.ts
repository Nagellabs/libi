import { createHash } from "crypto";

/** Content-derived revision for a sketch PNG's bytes, used to bust the
 *  browser's cache for `sketchUrl` (see components/storyboard/card/
 *  sketches-row.tsx) only when the drawing actually changed.
 *
 *  This is deliberately a hash of the file's CONTENT, not its mtime.
 *  `handleStoryboardChange` (lib/storyboard/watcher.ts) re-renders every
 *  card's sketches on ANY storyboard change — including a text-only edit to
 *  a card's title — which rewrites every sketch PNG on the board with
 *  byte-identical content and a fresh mtime. An mtime-based revision would
 *  bust every sketch's cache on every text edit; a content hash only
 *  changes when the pixels do. Do not "optimise" this back to `fs.stat`. */
export function sketchRev(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex").slice(0, 12);
}
