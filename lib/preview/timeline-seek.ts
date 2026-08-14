/**
 * Pure helper: given a click's clientX and the lane's left DOM edge, return the
 * composition FRAME under the cursor, clamped to the timeline. Uses the same
 * LaneView geometry as lane-bar-geometry. NO React, NO DOM.
 */
import type { LaneView } from "@/lib/preview/lane-bar-geometry";

export function seekFrameFromClick(args: {
  clientX: number;
  laneLeft: number;
  view: LaneView;
}): number {
  const { clientX, laneLeft, view } = args;
  if (view.trackWidth <= 0 || view.totalFrames <= 0) return 0;
  const x = clientX - laneLeft;
  const ratio = Math.max(0, Math.min(1, x / view.trackWidth));
  const frame = Math.round(ratio * (view.totalFrames - 1));
  return Math.max(0, Math.min(view.totalFrames - 1, frame));
}
