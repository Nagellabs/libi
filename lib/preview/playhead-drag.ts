/** Map a pointer clientX to a playhead frame against the timeline lane.
 *  Pure — shared by the playhead strip surface, the pin handle, and the
 *  spanning line so all three scrub identically. Mirrors the mapping the
 *  old ruler used: clamp x into the lane, then round the ratio across
 *  totalFrames - 1. */
export function frameFromClientX(args: {
  clientX: number;
  /** getBoundingClientRect().left of the lane element. */
  laneLeft: number;
  /** Rendered lane width in px (renderWidth). */
  laneWidth: number;
  totalFrames: number;
}): number {
  const { clientX, laneLeft, laneWidth, totalFrames } = args;
  if (totalFrames <= 0 || laneWidth <= 0) return 0;
  const x = Math.max(0, Math.min(clientX - laneLeft, laneWidth));
  return Math.round((x / laneWidth) * (totalFrames - 1));
}
