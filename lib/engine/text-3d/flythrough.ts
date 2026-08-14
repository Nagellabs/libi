/** Camera "paint-on" caption motion: an extruded word is laid out on X (centered
 *  at the origin, ~1 world-unit tall) and PAINTED letter-by-letter from the first
 *  glyph. A 3/4 SIDE camera tracks the letter currently being painted — sitting
 *  off to the side and looking back along the word so each glyph reveals its
 *  extruded PROFILE (depth), with the already-painted letters trailing behind.
 *  The shot finishes framed on the last letter. Pure math (no three/GL) so it's
 *  unit-testable; the builder reads `flythroughFrame` per render frame to drive
 *  the camera + per-glyph reveal. */

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Smooth ease so the dolly starts/stops gently instead of linear streaking. */
export function easeInOutQuad(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

export interface FlythroughFrame {
  /** The x up to which glyphs are "written" (a glyph at localX ≤ this is shown). */
  writeFront: number;
  /** Camera position. */
  camX: number;
  camY: number;
  camZ: number;
  /** Camera look-at target. */
  lookX: number;
  lookY: number;
  lookZ: number;
}

/** 3/4 side-view geometry. The camera sits `DEFAULT_SIDE_X` to the side of the
 *  painting letter and `CAM_Z` in front of the wall; the atan(side/CAM_Z) offset
 *  from the front normal is what shows each glyph's extruded side (its profile).
 *  Small CAM_Z/side ⇒ the camera is CLOSE, so the letters read BIG. */
const DEFAULT_SIDE_X = 1.05;
const CAM_Z = 0.9;

/** Sweep sense for the paint-on caption. `ltr`/`rtl` are 3/4 side dollies;
 *  `through` flies straight through the word plane (a "wall" framing). */
export type FlythroughDirection = "ltr" | "rtl" | "through";

/** Knobs for {@link flythroughFrame}. `sideOffset` widens/narrows the camera's
 *  x distance from the active letter (ltr/rtl only). */
export interface FlythroughOpts {
  direction?: FlythroughDirection;
  sideOffset?: number;
}

/**
 * Resolve the camera + paint-front for the paint-on caption at `progress` (0→1)
 * over a word of world width `wordWidth`. The front sweeps LINEARLY across the
 * word so glyphs reveal letter-by-letter; the camera tracks the active letter.
 *
 * - `ltr` (default): front sweeps left→right, camera sits to the -x side/behind.
 * - `rtl`: front sweeps right→left, camera sits to the +x side.
 * - `through`: camera stays centered in x and dollies far→near→far as the reveal
 *   crosses the middle (a head-on "wall" framing).
 *
 * Default behaviour (`ltr`, default `sideOffset`) is byte-identical to before.
 */
export function flythroughFrame(
  progress: number,
  wordWidth: number,
  opts: FlythroughOpts = {},
): FlythroughFrame {
  const w = Math.max(0, wordWidth);
  const half = w / 2;
  const tail = clamp(w * 0.02, 0.2, 0.6); // a touch past the last glyph so it fully paints
  const p = clamp(progress, 0, 1);
  const side = opts.sideOffset ?? DEFAULT_SIDE_X;
  const dir = opts.direction ?? "ltr";

  if (dir === "through") {
    // Camera flies straight through the word plane (the "wall" framing): x stays
    // centered, z ramps far→near→far as the reveal sweeps L→R.
    const writeFront = -half + (w + tail) * p;
    const lookX = Math.min(writeFront, half);
    const camZ = CAM_Z * (0.25 + 0.75 * Math.abs(2 * p - 1));
    return { writeFront, camX: 0, camY: 0.12, camZ, lookX, lookY: 0, lookZ: 0 };
  }

  if (dir === "rtl") {
    const writeFront = half - (w + tail) * p; // sweep right→left
    const lookX = Math.max(writeFront, -half);
    return { writeFront, camX: lookX + side, camY: 0.12, camZ: CAM_Z, lookX, lookY: 0, lookZ: 0 };
  }

  // ltr (default) — unchanged behaviour.
  const writeFront = -half + (w + tail) * p;
  const lookX = Math.min(writeFront, half);
  return { writeFront, camX: lookX - side, camY: 0.12, camZ: CAM_Z, lookX, lookY: 0, lookZ: 0 };
}

/**
 * Whether a glyph at `glyphX` is "painted" yet. `dir` controls the sweep sense:
 * ltr/through paint when the front has reached or passed the glyph (front ≥ x);
 * rtl paints when the front has reached or passed it from the right (front ≤ x).
 * A glyph appears at FULL size (no scale pop / grow-in).
 */
export function glyphPainted(
  writeFront: number,
  glyphX: number,
  dir: FlythroughDirection = "ltr",
): boolean {
  return dir === "rtl" ? writeFront <= glyphX : writeFront >= glyphX;
}
