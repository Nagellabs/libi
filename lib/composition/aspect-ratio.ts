/**
 * The aspect ratios libi offers, and the pure helpers that map between a
 * composition's pixel dimensions and that catalog.
 *
 * Orientation and ratio id are DERIVED here, never stored. The agent can set
 * arbitrary dimensions via `libi.update_composition_dimensions`, so a
 * persisted "portrait" label would silently disagree with a 1920x1080 frame
 * the next time it did.
 *
 * No I/O, no imports from the app — this module is safe to use from the
 * server, the MCP child and the browser alike.
 */

export type Orientation = "portrait" | "square" | "landscape";

export interface AspectRatioOption {
  /** Catalog id, also the display label — e.g. "9:16". */
  id: string;
  /** Ratio numerator (width part). */
  w: number;
  /** Ratio denominator (height part). */
  h: number;
  orientation: Orientation;
  /** Where this shape is normally published. Shown under the label. */
  hint: string;
}

/**
 * Every ratio derives its pixels from a fixed 1080 SHORT edge. That keeps all
 * six results even-numbered, which H.264 yuv420p requires — an odd dimension
 * fails at encode time, a long way from where this list is edited.
 */
export const SHORT_EDGE = 1080;

export const ASPECT_RATIOS: readonly AspectRatioOption[] = [
  { id: "9:16", w: 9, h: 16, orientation: "portrait", hint: "TikTok, Reels, Shorts" },
  { id: "4:5", w: 4, h: 5, orientation: "portrait", hint: "Instagram feed post" },
  { id: "1:1", w: 1, h: 1, orientation: "square", hint: "Square post" },
  { id: "16:9", w: 16, h: 9, orientation: "landscape", hint: "YouTube, X, web" },
  { id: "4:3", w: 4, h: 3, orientation: "landscape", hint: "Presentation, classic" },
  { id: "21:9", w: 21, h: 9, orientation: "landscape", hint: "Cinematic" },
] as const;

/** Most pieces are social video, so portrait is the product default. */
export const DEFAULT_ASPECT_RATIO_ID = "9:16";

/**
 * How close a composition's aspect must be to a catalog entry to be labelled
 * as it: 2% relative. Loose enough to absorb real-world rounding (a 1912x1080
 * crop still reads as 16:9), tight enough to reject a genuinely different
 * shape (16:10 sits 10% from 16:9 and must read as custom).
 */
const MATCH_TOLERANCE = 0.02;

export function ratioById(id: string): AspectRatioOption | null {
  return ASPECT_RATIOS.find((r) => r.id === id) ?? null;
}

/**
 * Classify a frame. A non-positive dimension cannot be classified at all;
 * these values come straight from a manifest, so returning the common case
 * beats throwing and taking the Preview row down with it.
 */
export function orientationOf(width: number, height: number): Orientation {
  if (!(width > 0) || !(height > 0)) return "landscape";
  if (width === height) return "square";
  return height > width ? "portrait" : "landscape";
}

/** Pixel dimensions for a catalog id, or null when the id is unknown. */
export function dimensionsFor(ratioId: string): { width: number; height: number } | null {
  const r = ratioById(ratioId);
  if (!r) return null;
  return r.w >= r.h
    ? { width: even(SHORT_EDGE * (r.w / r.h)), height: SHORT_EDGE }
    : { width: SHORT_EDGE, height: even(SHORT_EDGE * (r.h / r.w)) };
}

/**
 * The catalog entry these dimensions represent, or null when none is within
 * MATCH_TOLERANCE. Null means "custom" — the caller should show the raw
 * pixels rather than the nearest entry, or the label would lie.
 */
export function nearestRatio(width: number, height: number): AspectRatioOption | null {
  if (!(width > 0) || !(height > 0)) return null;
  const target = width / height;
  let best: AspectRatioOption | null = null;
  let bestDiff = Infinity;
  for (const r of ASPECT_RATIOS) {
    const diff = Math.abs(r.w / r.h - target) / target;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  return bestDiff <= MATCH_TOLERANCE ? best : null;
}

/** Short human label for a frame: the catalog id, else explicit pixels. */
export function describeRatio(width: number, height: number): string {
  return nearestRatio(width, height)?.id ?? `${width}x${height}`;
}

/**
 * Snap to the NEAREST even integer — H.264 yuv420p rejects odd dimensions.
 *
 * Nothing in the current catalog reaches this: all six ratios divide 1080
 * exactly (1920, 1350, 1080, 1920, 1440, 2520). It is a guard for a future
 * entry that does not, which is also why no test exercises its rounding.
 */
function even(n: number): number {
  return Math.round(n / 2) * 2;
}
