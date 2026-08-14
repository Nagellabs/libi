import { describe, expect, it } from "vitest";
import { layoutSequentialOverlays } from "@/lib/storyboard/sequence-layout";

describe("layoutSequentialOverlays", () => {
  it("packs items back-to-back from zero", () => {
    expect(layoutSequentialOverlays([
      { overlayId: "a", duration: 3 },
      { overlayId: "b", duration: 4 },
      { overlayId: "c", duration: 2 },
    ])).toEqual([
      { overlayId: "a", startTime: 0 },
      { overlayId: "b", startTime: 3 },
      { overlayId: "c", startTime: 7 },
    ]);
  });

  it("re-flows everything after a changed duration", () => {
    expect(layoutSequentialOverlays([
      { overlayId: "a", duration: 10 },
      { overlayId: "b", duration: 4 },
    ])).toEqual([
      { overlayId: "a", startTime: 0 },
      { overlayId: "b", startTime: 10 },
    ]);
  });

  it("is order-sensitive — the caller supplies cardOrder", () => {
    expect(layoutSequentialOverlays([
      { overlayId: "b", duration: 4 },
      { overlayId: "a", duration: 3 },
    ])).toEqual([
      { overlayId: "b", startTime: 0 },
      { overlayId: "a", startTime: 4 },
    ]);
  });

  it("handles an empty list", () => {
    expect(layoutSequentialOverlays([])).toEqual([]);
  });

  it("treats a non-finite or negative duration as zero rather than poisoning every later offset", () => {
    expect(layoutSequentialOverlays([
      { overlayId: "a", duration: Number.NaN },
      { overlayId: "b", duration: 5 },
    ])).toEqual([
      { overlayId: "a", startTime: 0 },
      { overlayId: "b", startTime: 0 },
    ]);
  });
});
