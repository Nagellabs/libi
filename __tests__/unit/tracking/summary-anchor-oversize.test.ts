/**
 * The quality summary must not flag a 100%-correct anchored close-up.
 *
 * `_is_degenerate_box` (mcp/tracking/py/libitrack/pipeline.py) and this
 * summary's `oversized_box_while_visible` deliberately share thresholds so the
 * engine and the report agree on what "degenerate" means. When the engine
 * learned to judge an ANCHOR-BOUND box against the anchor rather than the frame
 * — the fix for `no_output` on legitimate close-ups — the summary was left on
 * the absolute rule, and the two drifted apart.
 *
 * Observed in the packaged app 2026-08-02: a 639x656 anchored astronaut in a
 * 1280x720 frame tracked at 291/291 = 100% visible, and the summary then
 * flagged EVERY frame of that correct track as oversized. `add_tracked_overlay`
 * treats that as blocking, so the agent's only route forward is
 * `acknowledgeQualityIssues: true` — training it to wave away the very gate
 * that exists to stop bad tracks reaching a composition.
 *
 * NB the trigger has to be the anchor tripping the SAME rule, not an area test:
 * that anchor's area is only ~45% of the frame (below the 0.55 arm) and it trips
 * the HEIGHT arm instead, so an area-only check would silently change nothing.
 */
import { describe, it, expect } from "vitest";
import { summarizeTrack } from "@/lib/tracking/summary";
import type { Track, TrackSample } from "@/lib/tracking/types";

const W = 1280;
const H = 720;

function samples(box: { w: number; h: number }, n = 30): TrackSample[] {
  return Array.from({ length: n }, (_, i) => ({
    t: i / 30,
    x: 300,
    y: 60,
    w: box.w,
    h: box.h,
    confidence: 0.9,
    visible: true,
  })) as TrackSample[];
}

function track(partial: Partial<Track>): Track {
  return {
    id: "trk-test",
    fileId: "file-1",
    framerate: 30,
    durationSec: 1,
    samples: [],
    ...partial,
  } as Track;
}

const OPTS = { frameW: W, frameH: H, clipDurationSec: 1 };
const ASTRONAUT = { w: 639.44, h: 656.01 }; // the real failing anchor/box

function hasOversize(t: Track): boolean {
  return summarizeTrack(t, OPTS).issues.some(
    (i) => i.kind === "oversized_box_while_visible",
  );
}

describe("oversized_box_while_visible respects the anchor", () => {
  it("does NOT flag a box that matches its own oversized anchor", () => {
    const t = track({
      samples: samples(ASTRONAUT),
      anchors: [{ fileId: "file-1", time: 0.5, bbox: [303.8, 61.2, ASTRONAUT.w, ASTRONAUT.h] }],
    });
    expect(
      hasOversize(t),
      "a 100%-visible track on the subject the user pointed at must not be " +
        "reported as a bad detection",
    ).toBe(false);
  });

  it("premise guard: that anchor really does trip the absolute rule", () => {
    // If this stops being true the test above proves nothing.
    expect(ASTRONAUT.h >= 0.82 * H).toBe(true);
    // …and specifically NOT via the area arm.
    expect(ASTRONAUT.w * ASTRONAUT.h >= 0.55 * W * H).toBe(false);
  });

  it("still flags a box that BALLOONED well past its anchor", () => {
    // Deliberately under the 0.9-area full-canvas threshold: a literally
    // full-frame box is reported as `full_canvas_while_visible` instead and is
    // excluded from this check, so it would prove nothing here.
    const ballooned = { w: 1000, h: 700 }; // 700_000 px
    const anchorArea = ASTRONAUT.w * ASTRONAUT.h;
    expect(ballooned.w * ballooned.h).toBeGreaterThan(anchorArea * 1.6);
    expect(ballooned.w * ballooned.h).toBeLessThan(0.9 * W * H);

    const t = track({
      samples: samples(ballooned),
      anchors: [{ fileId: "file-1", time: 0.5, bbox: [303.8, 61.2, ASTRONAUT.w, ASTRONAUT.h] }],
    });
    expect(hasOversize(t)).toBe(true);
  });

  it("keeps the absolute rule when there are NO anchors", () => {
    const t = track({ samples: samples({ w: 1100, h: 700 }) });
    expect(hasOversize(t)).toBe(true);
  });

  it("keeps the absolute rule when the anchors are normal-sized", () => {
    // A small anchor must not license a giant box.
    const t = track({
      samples: samples({ w: 1100, h: 700 }),
      anchors: [{ fileId: "file-1", time: 0.5, bbox: [100, 100, 80, 200] }],
    });
    expect(hasOversize(t)).toBe(true);
  });

  it("does not flag an ordinary subject either way", () => {
    const t = track({ samples: samples({ w: 200, h: 400 }) });
    expect(hasOversize(t)).toBe(false);
  });
});
