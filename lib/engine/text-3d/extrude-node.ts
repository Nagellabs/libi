/** NODE-ONLY font loading from a local filesystem path.
 *
 *  This module imports `node:fs` and therefore MUST NOT be reachable from the
 *  client bundle — the chunking context cannot bundle external node modules.
 *  Only node contexts (the unit tests, future server-side font helpers) may
 *  import it. The browser path lives in `extrude.ts` (parseFontBytes /
 *  loadFontFromUrl). */

import { readFileSync } from "node:fs";
import type opentype from "opentype.js";
import { parseFontBytes } from "@/lib/engine/text-3d/extrude";

const fontByPath = new Map<string, Promise<opentype.Font>>();

/** Parse a font from a local filesystem path (node-side). `.buffer.slice(...)`
 *  detaches a clean copy from the Node Buffer's pooled backing store (a bare
 *  `.buffer` can include unrelated bytes). Cached per path. */
export function loadFont(path: string): Promise<opentype.Font> {
  const cached = fontByPath.get(path);
  if (cached) return cached;
  const p = (async () => {
    const buf = readFileSync(path);
    return parseFontBytes(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  })();
  fontByPath.set(path, p);
  void p.catch(() => fontByPath.delete(path)); // don't cache a rejected load
  return p;
}
