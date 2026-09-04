/**
 * Pure decisions for keeping the playhead reachable when the timeline is wider
 * than its panel: where to scroll so a moved playhead is on screen, how fast to
 * auto-scroll while a drag is held near an edge, and what x a zoom should be
 * anchored at. NO React, NO DOM — the timeline applies the numbers.
 *
 * COORDINATES: every x is in LANE pixels, post-rail — 0 is the lane's left edge
 * and the lane is `contentWidth` wide. The track rail is `position: sticky`, so
 * it always covers the viewport's first RAIL_WIDTH px and never enters this
 * math: a lane point is visible exactly when it lies in
 * [scrollLeft, scrollLeft + viewportWidth].
 */

export interface FollowView {
  /** Playhead position in lane px. */
  playheadX: number;
  /** Current horizontal scroll offset in lane px. */
  scrollLeft: number;
  /** Visible lane width in px (the measured post-rail viewport). */
  viewportWidth: number;
  /** Full lane width in px at the current zoom. */
  contentWidth: number;
}

/** Where the playhead lands after a follow-scroll, as a fraction of the
 *  viewport from its left edge — leaves the upcoming timeline in view rather
 *  than centring on what has already played. */
export const FOLLOW_REENTRY_FRACTION = 0.1;

/** How close to an edge a held drag must be before the view starts scrolling. */
export const EDGE_SCROLL_ZONE_PX = 24;

/** Fastest edge auto-scroll, in px per animation frame (~1440 px/s at 60fps). */
export const EDGE_SCROLL_MAX_PX_PER_TICK = 24;

/** True only when every field of the view is a finite number. A NaN/Infinity
 *  input (e.g. a `0/0` playhead percent on a single-frame piece) must never
 *  reach `el.scrollLeft` — browsers normalise a non-finite scrollLeft to 0 (a
 *  forced jump), and jsdom stores NaN verbatim. Matches the defensive style of
 *  `clampPxPerSec` in the sibling `timeline-zoom.ts`. */
function isFiniteView(view: FollowView): boolean {
  return (
    Number.isFinite(view.playheadX) &&
    Number.isFinite(view.scrollLeft) &&
    Number.isFinite(view.viewportWidth) &&
    Number.isFinite(view.contentWidth)
  );
}

/** The largest valid scrollLeft — 0 when the content fits (i.e. at Fit). */
export function maxScrollLeft(view: FollowView): number {
  if (!Number.isFinite(view.contentWidth) || !Number.isFinite(view.viewportWidth)) return 0;
  return Math.max(0, view.contentWidth - view.viewportWidth);
}

export function isPlayheadVisible(view: FollowView): boolean {
  if (
    !Number.isFinite(view.playheadX) ||
    !Number.isFinite(view.scrollLeft) ||
    !Number.isFinite(view.viewportWidth)
  ) {
    return false;
  }
  return (
    view.playheadX >= view.scrollLeft &&
    view.playheadX <= view.scrollLeft + view.viewportWidth
  );
}

/**
 * The scrollLeft that brings the playhead back into view, or null when no
 * scroll is needed (already visible, nothing scrollable, the target equals
 * the current offset, or any input is non-finite — degrade to "don't scroll"
 * rather than propagate a NaN).
 */
export function followScrollLeft(view: FollowView): number | null {
  if (!isFiniteView(view)) return null;
  const max = maxScrollLeft(view);
  if (max <= 0) return null;
  if (isPlayheadVisible(view)) return null;
  const target = Math.max(
    0,
    Math.min(max, view.playheadX - FOLLOW_REENTRY_FRACTION * view.viewportWidth),
  );
  return target === view.scrollLeft ? null : target;
}

/**
 * Per-frame scroll delta for a drag held near a lane edge: negative scrolls
 * left, positive right, 0 means the pointer is clear of both zones. Speed ramps
 * linearly with depth into the zone and saturates at the edge, so a pointer
 * parked just outside the lane scrolls steadily instead of jumping.
 */
export function edgeScrollDelta(args: {
  /** Pointer x relative to the VISIBLE lane's left edge (0 … viewportWidth). */
  pointerX: number;
  viewportWidth: number;
}): number {
  const { pointerX, viewportWidth } = args;
  if (!Number.isFinite(pointerX) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return 0;
  // A viewport narrower than two zones would put a pointer in both at once;
  // splitting at the midpoint keeps exactly one edge active.
  const zone = Math.min(EDGE_SCROLL_ZONE_PX, viewportWidth / 2);
  if (zone <= 0) return 0;
  if (pointerX < zone) {
    const depth = Math.min(1, (zone - pointerX) / zone);
    return -depth * EDGE_SCROLL_MAX_PX_PER_TICK;
  }
  const fromRight = viewportWidth - pointerX;
  if (fromRight < zone) {
    const depth = Math.min(1, (zone - fromRight) / zone);
    return depth * EDGE_SCROLL_MAX_PX_PER_TICK;
  }
  return 0;
}

/**
 * Viewport-relative x a zoom should keep fixed: the playhead when it is on
 * screen (the user's centre of attention), else the middle of the view.
 */
export function zoomAnchorX(view: FollowView): number {
  if (!Number.isFinite(view.viewportWidth)) return 0;
  // isPlayheadVisible already degrades to false on a non-finite playheadX/
  // scrollLeft, so a NaN playheadX falls through to the viewport-centre
  // branch below rather than propagating into the returned anchor.
  if (isPlayheadVisible(view)) return view.playheadX - view.scrollLeft;
  return view.viewportWidth / 2;
}
