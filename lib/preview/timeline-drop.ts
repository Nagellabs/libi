/**
 * Pure mapping from a drop x-coordinate within a timeline lane to a start
 * time + the target row's group/z. Used by the drag-media-onto-a-lane path.
 */
export interface ResolveDropArgs {
  clientX: number;
  laneRect: { left: number; width: number };
  durationSec: number;
  rowGroup?: string;
  rowZ: number;
}

export interface ResolveDropResult {
  startTime: number;
  z: number;
  group?: string;
}

export function resolveDrop(args: ResolveDropArgs): ResolveDropResult {
  const { clientX, laneRect, durationSec, rowGroup, rowZ } = args;
  let startTime = 0;
  if (laneRect.width > 0 && durationSec > 0) {
    const frac = Math.min(1, Math.max(0, (clientX - laneRect.left) / laneRect.width));
    startTime = frac * durationSec;
  }
  return { startTime, z: rowZ, ...(rowGroup ? { group: rowGroup } : {}) };
}
