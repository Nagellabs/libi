import type { ExportAspect } from "./types";

/** A frame counts as an aspect when its ratio is within 1 % of it (spec §A1). */
export const ASPECT_TOLERANCE = 0.01;

const TARGETS: ReadonlyArray<readonly [Exclude<ExportAspect, "other">, number]> = [
  ["9:16", 9 / 16],
  ["16:9", 16 / 9],
  ["1:1", 1],
  ["4:5", 4 / 5],
];

/** The export's aspect label, derived from its frame. Pure. */
export function aspectOf(width: number | null | undefined, height: number | null | undefined): ExportAspect {
  if (!width || !height || width <= 0 || height <= 0) return "other";
  const ratio = width / height;
  for (const [label, target] of TARGETS) {
    if (Math.abs(ratio - target) / target <= ASPECT_TOLERANCE) return label;
  }
  return "other";
}
