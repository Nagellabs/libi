import { describe, it, expect } from "vitest";
import { recoverManualBbox } from "@/lib/tracking/manual-anchors";

// The renderer consumes sample coords directly as composition px. A manual
// bbox recovered in composition px is therefore a valid TrackSample-space
// bbox. This test PINS that invariant: when composition == source dims
// (the realistic single-video case), the recovered bbox is used verbatim as
// the engine Anchor.bbox with NO scale. If a future non-1:1 piece appears,
// this test must be extended with the videoDim/compDim scale at the seeding
// boundary (see spec Gate C) — failing here is the signal to do that.
describe("Gate C: manual-anchor coordinate space", () => {
  it("recovered bbox is composition-px == TrackSample-px (no scale) for 1:1 pieces", () => {
    const bbox = recoverManualBbox({
      sample: { x: 100, y: 100, w: 50, h: 50 },
      fit: "tight", scale: 1,
      rect: { x: 0, y: 0, width: 50, height: 50 },
      frame: { width: 1920, height: 1080 },
      dropCenter: { x: 300, y: 300 },
    });
    // Pure translation in the shared space — no implicit rescale.
    expect(bbox).toEqual([275, 275, 50, 50]);
  });
});
