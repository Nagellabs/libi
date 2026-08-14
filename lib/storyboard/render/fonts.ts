import fs from "fs";
import path from "path";

let cached: Buffer | null = null;

/** The vendored default font (Geist, OFL-1.1) used by the Satori renderer.
 *  Read once and cached for the process lifetime. */
export function loadDefaultFont(): Buffer {
  if (!cached) {
    cached = fs.readFileSync(
      path.join(process.cwd(), "lib/storyboard/render/fonts/Geist-Regular.ttf"),
    );
  }
  return cached;
}

export const DEFAULT_FONT_NAME = "Geist";
