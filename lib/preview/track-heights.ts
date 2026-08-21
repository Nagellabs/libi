/**
 * Pure height-distribution for the timeline track stack. Each row has a min
 * height and a growth weight; leftover vertical space is shared by weight so the
 * stack fills the panel exactly. NO React, NO DOM. Integer px out (rounding
 * remainder goes to the highest-weight rows so the sum is exact).
 */
import type { TrackRowVM } from "@/lib/preview/track-stack-view-model";

export interface TrackRowSizing {
  id: string;
  /** Never render shorter than this. */
  minHeight: number;
  /** Share of leftover space (0 = never grows). */
  weight: number;
}

const SUB_LANE_BASE = 28;
const SMALL = 1,
  MEDIUM = 3,
  LARGE = 5;

/**
 * Pure classifier: map one track-stack row to its `{ minHeight, weight }`.
 * Small growth (weight 1): captions(text) + audio. Large growth (weight 5):
 * stickers(image/video) + graphics(code/three) + tracked. Medium (3):
 * custom/unknown overlay groups. Overlay row minHeight reserves its stacked
 * sub-lanes (`subLaneCount * 28`).
 */
export function rowSizing(row: TrackRowVM): TrackRowSizing {
  if (row.kind === "coupledAudio") {
    // Slim strip attached under its video (Timeline sizes this directly, but
    // keep rowSizing total over the union). Never grows.
    return { id: `coupled-${row.clipId}`, minHeight: 16, weight: 0 };
  }
  if (row.kind === "audioTrack") {
    // Independent detached audio track (Timeline sizes this directly too, but
    // keep rowSizing total over the union). SHORT, fixed; never grows.
    return { id: `track-${row.clipId}`, minHeight: 22, weight: 0 };
  }
  if (row.kind === "audio") {
    // The audio section stacks one ~24px lane per clip (+4px gaps), so its true
    // minimum scales with clip count — otherwise a multi-clip row would overflow
    // its allotted height at a short panel size.
    const n = row.clipIds.length;
    const minHeight = Math.max(22, n * 24 + Math.max(0, n - 1) * 4);
    return { id: "audio", minHeight, weight: SMALL };
  }
  // overlay row
  const subLanes = Math.max(1, row.row.subLaneCount);
  const minHeight = subLanes * SUB_LANE_BASE;
  const weight =
    row.group === "captions"
      ? SMALL
      : row.group === "stickers" || row.group === "graphics" || row.group === "tracked"
        ? LARGE
        : MEDIUM;
  return { id: `ov-${row.group}`, minHeight, weight };
}

export function distributeTrackHeights(args: {
  rows: TrackRowSizing[];
  available: number;
  gap: number;
}): Record<string, number> {
  const { rows, available, gap } = args;
  const out: Record<string, number> = {};
  if (rows.length === 0) return out;

  const totalGap = gap * (rows.length - 1);
  const minSum = rows.reduce((s, r) => s + r.minHeight, 0);
  const totalWeight = rows.reduce((s, r) => s + Math.max(0, r.weight), 0);
  const leftover = available - totalGap - minSum;

  if (leftover <= 0 || totalWeight <= 0) {
    for (const r of rows) out[r.id] = r.minHeight;
    return out;
  }

  const extra: Record<string, number> = {};
  let assigned = 0;
  for (const r of rows) {
    const e = Math.floor((leftover * Math.max(0, r.weight)) / totalWeight);
    extra[r.id] = e;
    assigned += e;
  }
  // Hand the rounding remainder to the highest-weight rows so the sum is exact.
  let remainder = leftover - assigned;
  const byWeight = [...rows].filter((r) => r.weight > 0).sort((a, b) => b.weight - a.weight);
  let i = 0;
  while (remainder > 0 && byWeight.length > 0) {
    extra[byWeight[i % byWeight.length].id] += 1;
    remainder -= 1;
    i += 1;
  }
  for (const r of rows) out[r.id] = r.minHeight + extra[r.id];
  return out;
}
