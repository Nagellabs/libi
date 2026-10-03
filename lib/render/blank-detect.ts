/**
 * "Effectively empty" frame detector for `libi.render_overlay_frames`.
 *
 * A body that throws draws nothing, and the frame still renders "fine" — a
 * flat background with no error in sight. This flags that case: all but a
 * sliver of the frame is ONE colour (the mode of a coarse sample). Pure and
 * dependency-free, like the edge-overflow detector next to it: the caller
 * decodes the PNG → RGBA and passes the raw buffer.
 *
 * A frame that is one flat colour on purpose (a fade to black) is reported
 * too; `blank` says what the pixels are, and the agent judges whether that
 * was the intent.
 */
export interface BlankFrameOptions {
  /** A pixel differs from the background when any channel differs by more than this. */
  tolerance?: number;
  /** Frames whose differing pixels are at most this fraction of the frame are blank. */
  maxDiffFraction?: number;
}

/** ~92 px of a 1280×720 frame: smaller than any legible glyph or icon. */
const DEFAULT_MAX_DIFF_FRACTION = 0.0001;
const DEFAULT_TOLERANCE = 12;
const SAMPLE_TARGET = 4096;

export function isBlankFrame(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: BlankFrameOptions = {},
): boolean {
  const total = width * height;
  if (total <= 0 || rgba.length < total * 4) return false;
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const maxDiff = Math.floor(total * (opts.maxDiffFraction ?? DEFAULT_MAX_DIFF_FRACTION));

  // Background = the most common colour of a strided sample (quantised to 6
  // bits per channel so a gradient's neighbours vote together).
  const stride = Math.max(1, Math.floor(total / SAMPLE_TARGET));
  const votes = new Map<number, number>();
  let best = 0;
  let bestKey = 0;
  for (let p = 0; p < total; p += stride) {
    const i = p * 4;
    const key = ((rgba[i] >> 2) << 16) | ((rgba[i + 1] >> 2) << 8) | (rgba[i + 2] >> 2);
    const n = (votes.get(key) ?? 0) + 1;
    votes.set(key, n);
    if (n > best) {
      best = n;
      bestKey = key;
    }
  }
  const bgR = ((bestKey >> 16) & 0xff) * 4 + 2;
  const bgG = ((bestKey >> 8) & 0xff) * 4 + 2;
  const bgB = (bestKey & 0xff) * 4 + 2;

  let diff = 0;
  for (let p = 0; p < total; p++) {
    const i = p * 4;
    if (
      Math.abs(rgba[i] - bgR) > tolerance ||
      Math.abs(rgba[i + 1] - bgG) > tolerance ||
      Math.abs(rgba[i + 2] - bgB) > tolerance
    ) {
      if (++diff > maxDiff) return false;
    }
  }
  return true;
}
