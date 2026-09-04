import { describe, it, expect } from "vitest";
import {
  maxScrollLeft,
  isPlayheadVisible,
  followScrollLeft,
  edgeScrollDelta,
  zoomAnchorX,
  EDGE_SCROLL_ZONE_PX,
  EDGE_SCROLL_MAX_PX_PER_TICK,
  type FollowView,
} from "@/lib/preview/playhead-follow";

/** A 3000px lane shown through a 1000px window scrolled to 500. */
const view = (over: Partial<FollowView> = {}): FollowView => ({
  playheadX: 600,
  scrollLeft: 500,
  viewportWidth: 1000,
  contentWidth: 3000,
  ...over,
});

describe("maxScrollLeft", () => {
  it("is the content overhang beyond the viewport", () => {
    expect(maxScrollLeft(view())).toBe(2000);
  });

  it("is 0 when the content fits the viewport (at Fit)", () => {
    expect(maxScrollLeft(view({ contentWidth: 800, viewportWidth: 1000 }))).toBe(0);
  });
});

describe("isPlayheadVisible", () => {
  it("is true inside the visible window, inclusive of both edges", () => {
    expect(isPlayheadVisible(view({ playheadX: 600 }))).toBe(true);
    expect(isPlayheadVisible(view({ playheadX: 500 }))).toBe(true);
    expect(isPlayheadVisible(view({ playheadX: 1500 }))).toBe(true);
  });

  it("is false past either edge", () => {
    expect(isPlayheadVisible(view({ playheadX: 499 }))).toBe(false);
    expect(isPlayheadVisible(view({ playheadX: 1501 }))).toBe(false);
  });
});

describe("followScrollLeft", () => {
  it("returns null while the playhead is already visible", () => {
    expect(followScrollLeft(view({ playheadX: 600 }))).toBeNull();
  });

  it("scrolls so the playhead re-enters at 10% from the left edge", () => {
    // playheadX 1800 is past the right edge (1500) → 1800 - 0.1*1000 = 1700
    expect(followScrollLeft(view({ playheadX: 1800 }))).toBe(1700);
  });

  it("follows backwards when the playhead is left of the window", () => {
    // playheadX 200 → 200 - 100 = 100
    expect(followScrollLeft(view({ playheadX: 200 }))).toBe(100);
  });

  it("clamps to 0 rather than scrolling negative near the start", () => {
    expect(followScrollLeft(view({ playheadX: 40, scrollLeft: 500 }))).toBe(0);
  });

  it("clamps to the maximum scroll near the end", () => {
    expect(followScrollLeft(view({ playheadX: 2990, scrollLeft: 500 }))).toBe(2000);
  });

  it("returns null when there is nothing to scroll (at Fit)", () => {
    const atFit = view({ contentWidth: 1000, viewportWidth: 1000, scrollLeft: 0, playheadX: 900 });
    expect(followScrollLeft(atFit)).toBeNull();
  });

  it("scrolls by the smallest amount when the playhead is only just past the edge", () => {
    // playheadX 1600 is 100px past the right edge; 1600 - 0.1*1000 = 1500.
    expect(followScrollLeft(view({ playheadX: 1600 }))).toBe(1500);
  });
});

describe("edgeScrollDelta", () => {
  it("is 0 in the middle of the lane", () => {
    expect(edgeScrollDelta({ pointerX: 500, viewportWidth: 1000 })).toBe(0);
  });

  it("is 0 exactly at the inner boundary of each edge zone", () => {
    expect(edgeScrollDelta({ pointerX: EDGE_SCROLL_ZONE_PX, viewportWidth: 1000 })).toBe(0);
    expect(edgeScrollDelta({ pointerX: 1000 - EDGE_SCROLL_ZONE_PX, viewportWidth: 1000 })).toBe(0);
  });

  it("scrolls left (negative) proportionally inside the left zone", () => {
    // 12px in from the left edge = halfway into the 24px zone
    expect(edgeScrollDelta({ pointerX: 12, viewportWidth: 1000 })).toBeCloseTo(
      -EDGE_SCROLL_MAX_PX_PER_TICK / 2,
      6,
    );
  });

  it("scrolls right (positive) proportionally inside the right zone", () => {
    expect(edgeScrollDelta({ pointerX: 988, viewportWidth: 1000 })).toBeCloseTo(
      EDGE_SCROLL_MAX_PX_PER_TICK / 2,
      6,
    );
  });

  it("runs at full speed at and beyond either edge", () => {
    expect(edgeScrollDelta({ pointerX: 0, viewportWidth: 1000 })).toBe(-EDGE_SCROLL_MAX_PX_PER_TICK);
    expect(edgeScrollDelta({ pointerX: -300, viewportWidth: 1000 })).toBe(-EDGE_SCROLL_MAX_PX_PER_TICK);
    expect(edgeScrollDelta({ pointerX: 1000, viewportWidth: 1000 })).toBe(EDGE_SCROLL_MAX_PX_PER_TICK);
    expect(edgeScrollDelta({ pointerX: 1300, viewportWidth: 1000 })).toBe(EDGE_SCROLL_MAX_PX_PER_TICK);
  });

  it("is 0 for a degenerate viewport", () => {
    expect(edgeScrollDelta({ pointerX: 5, viewportWidth: 0 })).toBe(0);
  });

  it("never scrolls both ways in a viewport narrower than two edge zones", () => {
    // 40px wide: the zones would overlap. The nearer edge must win, never both.
    const left = edgeScrollDelta({ pointerX: 5, viewportWidth: 40 });
    const right = edgeScrollDelta({ pointerX: 35, viewportWidth: 40 });
    expect(left).toBeLessThan(0);
    expect(right).toBeGreaterThan(0);
    expect(edgeScrollDelta({ pointerX: 20, viewportWidth: 40 })).toBe(0);
  });
});

describe("non-finite inputs (e.g. a single-frame piece's 0/0 playhead percent)", () => {
  it("maxScrollLeft returns 0 rather than NaN when contentWidth or viewportWidth is non-finite", () => {
    expect(maxScrollLeft(view({ contentWidth: NaN }))).toBe(0);
    expect(maxScrollLeft(view({ viewportWidth: NaN }))).toBe(0);
    expect(maxScrollLeft(view({ contentWidth: Infinity }))).toBe(0);
  });

  it("isPlayheadVisible is false (never NaN-compares true) when any field is non-finite", () => {
    expect(isPlayheadVisible(view({ playheadX: NaN }))).toBe(false);
    expect(isPlayheadVisible(view({ scrollLeft: NaN }))).toBe(false);
    expect(isPlayheadVisible(view({ viewportWidth: NaN }))).toBe(false);
  });

  it("followScrollLeft returns null (no scroll) rather than propagating NaN", () => {
    expect(followScrollLeft(view({ playheadX: NaN }))).toBeNull();
    expect(followScrollLeft(view({ scrollLeft: NaN }))).toBeNull();
    expect(followScrollLeft(view({ viewportWidth: NaN }))).toBeNull();
    expect(followScrollLeft(view({ contentWidth: NaN }))).toBeNull();
    expect(followScrollLeft(view({ playheadX: Infinity }))).toBeNull();
  });

  it("edgeScrollDelta is 0 for a non-finite pointerX or viewportWidth", () => {
    expect(edgeScrollDelta({ pointerX: NaN, viewportWidth: 1000 })).toBe(0);
    expect(edgeScrollDelta({ pointerX: 12, viewportWidth: NaN })).toBe(0);
    expect(edgeScrollDelta({ pointerX: Infinity, viewportWidth: 1000 })).toBe(0);
  });

  it("zoomAnchorX falls back to a finite anchor when playheadX is non-finite", () => {
    // isPlayheadVisible degrades to false on a NaN playheadX, so this must
    // fall through to the viewport-centre branch rather than returning NaN.
    expect(zoomAnchorX(view({ playheadX: NaN }))).toBe(500);
  });

  it("zoomAnchorX returns 0 rather than NaN when viewportWidth itself is non-finite", () => {
    expect(zoomAnchorX(view({ viewportWidth: NaN }))).toBe(0);
  });
});

describe("zoomAnchorX", () => {
  it("anchors at the playhead when it is visible", () => {
    // playheadX 600, scrollLeft 500 ⇒ 100px from the visible left edge
    expect(zoomAnchorX(view({ playheadX: 600 }))).toBe(100);
  });

  it("anchors at the viewport centre when the playhead is off-screen", () => {
    expect(zoomAnchorX(view({ playheadX: 2500 }))).toBe(500);
  });
});
