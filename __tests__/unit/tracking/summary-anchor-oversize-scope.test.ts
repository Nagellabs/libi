/**
 * The anchor relaxation, in both directions it was wrong.
 *
 * `summary-anchor-oversize.test.ts` covers what the relaxation was FOR: a
 * 639x656 anchored astronaut must not be reported as a bad detection. This
 * file covers what it gave away doing it.
 *
 * TOO LAX (E1). The licence was track-global and time-blind, so one close-up
 * anchor at t=0 excused a wrong-subject balloon fifteen seconds later. And
 * because the licence was uncapped, any anchor at or above 0.5625·W·H pushed
 * the threshold past the 0.9·W·H full-canvas cutoff — making the flag
 * mathematically unable to fire, with the entire 55–90% band unmonitored.
 * `identity_switch_suspected` does not cover that: it needs ReID data, and a
 * balloon that still contains the subject keeps similarity high.
 *
 * TOO NARROW (E2). It read only `track.anchors`, which is written once at init
 * from the first segment. Repair anchors (`agentAnchors`), user pins
 * (`manualAnchors`) and later fan-out shots never participated — so the false
 * block came straight back on the repair loop the `using-object-tracking`
 * skill teaches. The identity-switch section in the same file already reads
 * all three channels.
 */
import { describe, it, expect } from "vitest";
import { summarizeTrack } from "@/lib/tracking/summary";
import type { Track, TrackSample } from "@/lib/tracking/types";

const W = 1280;
const H = 720;
const OPTS = { frameW: W, frameH: H, clipDurationSec: 30 };
const ASTRONAUT = { w: 639.44, h: 656.01 };

/** `n` samples of a fixed box, starting at `from` seconds. */
function run(box: { w: number; h: number }, from: number, n = 30): TrackSample[] {
  return Array.from({ length: n }, (_, i) => ({
    t: from + i / 30,
    x: 100,
    y: 20,
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
    durationSec: 30,
    samples: [],
    ...partial,
  } as Track;
}

const oversizeRanges = (t: Track) =>
  summarizeTrack(t, OPTS).issues.filter(
    (i) => i.kind === "oversized_box_while_visible",
  );

describe("E1 — an anchor licenses only the arm it trips", () => {
  const BALLOON = { w: 1100, h: 580 };

  it("premise guard: the escape the single-area licence created", () => {
    // The balloon is over the WIDTH and AREA arms on its own …
    expect(BALLOON.w >= 0.82 * W).toBe(true);
    expect(BALLOON.w * BALLOON.h >= 0.55 * W * H).toBe(true);
    // …and NOT full-canvas, which is a different flag that would mask it.
    expect(BALLOON.w * BALLOON.h < 0.9 * W * H).toBe(true);
    // …yet it measures LESS than 1.6× the astronaut anchor's area, which is
    // the single test the old relaxation reduced everything to.
    expect(BALLOON.w * BALLOON.h).toBeLessThan(ASTRONAUT.w * ASTRONAUT.h * 1.6);
    // The astronaut anchor trips HEIGHT only — nothing about it says a
    // frame-wide box is now acceptable.
    expect(ASTRONAUT.h >= 0.82 * H).toBe(true);
    expect(ASTRONAUT.w >= 0.82 * W).toBe(false);
    expect(ASTRONAUT.w * ASTRONAUT.h >= 0.55 * W * H).toBe(false);
  });

  it("flags a frame-wide balloon under a merely TALL anchor", () => {
    const t = track({
      samples: [...run(ASTRONAUT, 0), ...run(BALLOON, 15)],
      anchors: [{ fileId: "file-1", time: 0.5, bbox: [100, 20, ASTRONAUT.w, ASTRONAUT.h] }],
    });
    const issues = oversizeRanges(t);
    expect(issues.length, "the balloon must be reported").toBe(1);
    expect(issues[0].range.start).toBeGreaterThan(10);
  });
});

describe("E1 — the licence can never reach the full-canvas cutoff", () => {
  // An anchor at 0.5625·W·H pushes 1.6× past 0.9·W·H, so before the cap the
  // area arm could not fire at ANY size below full-canvas.
  const HUGE_ANCHOR = { w: 900, h: 576 }; // 518_400 = 0.5625 · W · H

  it("premise guard: this anchor's uncapped licence reaches full-canvas", () => {
    expect(HUGE_ANCHOR.w * HUGE_ANCHOR.h * 1.6).toBeGreaterThanOrEqual(0.9 * W * H);
    expect(HUGE_ANCHOR.w * HUGE_ANCHOR.h >= 0.55 * W * H).toBe(true);
  });

  it("still flags an 88%-of-frame box under such an anchor", () => {
    const big = { w: 1200, h: 676 }; // 811_200 ≈ 0.88 · W · H — under full-canvas
    expect(big.w * big.h).toBeLessThan(0.9 * W * H);
    const t = track({
      samples: run(big, 0),
      anchors: [{ fileId: "file-1", time: 0.5, bbox: [0, 0, HUGE_ANCHOR.w, HUGE_ANCHOR.h] }],
    });
    expect(oversizeRanges(t).length).toBe(1);
  });

  it("flags a box whose AREA alone exceeds the cap", () => {
    // Under both dimension arms, but 0.82 of frame area — the band the
    // uncapped licence left permanently unmonitored.
    const wide = { w: 1040, h: 710 }; // 738_400 ≈ 0.80 · W · H
    expect(wide.w < 0.82 * W).toBe(true);
    expect(wide.h >= 0.82 * H).toBe(true);
    const t = track({
      samples: run(wide, 0),
      // An anchor that trips the height arm AND the area arm, so both are
      // relaxed — and the area cap is what still catches this.
      anchors: [{ fileId: "file-1", time: 0.5, bbox: [0, 0, HUGE_ANCHOR.w, 700] }],
    });
    expect(oversizeRanges(t).length).toBe(1);
  });
});

describe("E2 — all three anchor channels participate", () => {
  const closeUp = run(ASTRONAUT, 0);

  it("an agent repair anchor spares the window it repaired", () => {
    // `track.anchors` is written once at init and never updated, so this is
    // the shape the repair loop actually produces.
    const t = track({
      samples: closeUp,
      agentAnchors: [{ id: "agt-500", time: 0.5, bbox: [100, 20, ASTRONAUT.w, ASTRONAUT.h] }],
    });
    expect(oversizeRanges(t).length).toBe(0);
  });

  it("a user's manual pin does too", () => {
    const t = track({
      samples: closeUp,
      manualAnchors: [
        { id: "man-500", time: 0.5, bbox: [100, 20, ASTRONAUT.w, ASTRONAUT.h], createdAt: 1 },
      ],
    } as Partial<Track>);
    expect(oversizeRanges(t).length).toBe(0);
  });

  it("with several anchors, the NEAREST one decides", () => {
    // A tiny anchor at t=0 and the real close-up anchor at t=20. The close-up
    // samples sit at t≈20, so the big anchor is the relevant one.
    const t = track({
      samples: run(ASTRONAUT, 20),
      anchors: [
        { fileId: "file-1", time: 0, bbox: [0, 0, 60, 90] },
        { fileId: "file-1", time: 20.5, bbox: [100, 20, ASTRONAUT.w, ASTRONAUT.h] },
      ],
    });
    expect(oversizeRanges(t).length).toBe(0);
  });
});
