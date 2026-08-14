import { describe, it, expect } from "vitest";
import { mixedBoxSemantics, dominantObjectKind } from "@/lib/tracking/segments";

describe("mixedBoxSemantics", () => {
  it("detects a face segment + a non-face body segment in one track", () => {
    const segs = [
      { id: "a", startTime: 0, endTime: 4, method: "yoloe+botsort", status: "ok", samples: [], objectKind: "face" },
      { id: "b", startTime: 4, endTime: 38, method: "yoloe+botsort", status: "ok", samples: [], objectKind: "object" },
    ] as never[];
    expect(mixedBoxSemantics(segs)).toBe(true);
  });
  it("false for a uniformly face-kind track", () => {
    const segs = [
      { id: "a", startTime: 0, endTime: 4, method: "yoloe+botsort", status: "ok", samples: [], objectKind: "face" },
      { id: "b", startTime: 4, endTime: 38, method: "yoloe+botsort", status: "ok", samples: [], objectKind: "face" },
    ] as never[];
    expect(mixedBoxSemantics(segs)).toBe(false);
  });
  it("false / ignores skipped+lost segments (only ok segments define semantics)", () => {
    const segs = [
      { id: "a", startTime: 0, endTime: 4, method: "yoloe+botsort", status: "ok", samples: [], objectKind: "object" },
      { id: "b", startTime: 4, endTime: 6, method: "skip", status: "skipped", samples: [], objectKind: "face" },
    ] as never[];
    expect(mixedBoxSemantics(segs)).toBe(false);
  });
});

describe("dominantObjectKind", () => {
  it("returns 'face' when all OK segments are face", () => {
    const segs = [
      { id: "a", startTime: 0, endTime: 4, method: "yoloe+botsort", status: "ok", samples: [], objectKind: "face" },
      { id: "b", startTime: 4, endTime: 10, method: "yoloe+botsort", status: "ok", samples: [], objectKind: "face" },
    ] as never[];
    expect(dominantObjectKind(segs)).toBe("face");
  });

  it("returns 'object' when all OK segments are object", () => {
    const segs = [
      { id: "a", startTime: 0, endTime: 4, method: "yoloe+botsort", status: "ok", samples: [], objectKind: "object" },
      { id: "b", startTime: 4, endTime: 10, method: "yoloe+botsort", status: "ok", samples: [] },
    ] as never[];
    expect(dominantObjectKind(segs)).toBe("object");
  });

  it("returns 'object' when there are no OK segments (empty)", () => {
    expect(dominantObjectKind([])).toBe("object");
  });

  it("returns 'object' when OK segments are absent (only skipped/lost)", () => {
    const segs = [
      { id: "a", startTime: 0, endTime: 4, method: "skip", status: "skipped", samples: [], objectKind: "face" },
      { id: "b", startTime: 4, endTime: 10, method: "yoloe+botsort", status: "lost", samples: [], objectKind: "face" },
    ] as never[];
    expect(dominantObjectKind(segs)).toBe("object");
  });

  it("returns 'object' when OK segments already disagree (already mixed)", () => {
    const segs = [
      { id: "a", startTime: 0, endTime: 4, method: "yoloe+botsort", status: "ok", samples: [], objectKind: "face" },
      { id: "b", startTime: 4, endTime: 10, method: "yoloe+botsort", status: "ok", samples: [], objectKind: "object" },
    ] as never[];
    expect(dominantObjectKind(segs)).toBe("object");
  });

  it("ignores skipped/lost segments when computing dominant kind", () => {
    const segs = [
      { id: "a", startTime: 0, endTime: 4, method: "yoloe+botsort", status: "ok", samples: [], objectKind: "face" },
      { id: "b", startTime: 4, endTime: 6, method: "skip", status: "skipped", samples: [], objectKind: "object" },
    ] as never[];
    expect(dominantObjectKind(segs)).toBe("face");
  });
});

describe("sam2-refine objectKind inheritance (regression lock)", () => {
  it("face track + sam2-refine segment that inherited 'face' does NOT trip mixedBoxSemantics", () => {
    // This is the FIXED behavior: sam2-refine segment inherits the parent track's objectKind
    const segs = [
      { id: "seg-0-10000", startTime: 0, endTime: 10, method: "yoloe+botsort", status: "ok", samples: [], objectKind: "face" },
      { id: "seg-sam2-refine-0", startTime: 0, endTime: 10, method: "sam2-refine", status: "ok", samples: [], objectKind: "face" },
    ] as never[];
    expect(mixedBoxSemantics(segs)).toBe(false);
  });

  it("face track + sam2-refine segment with absent/object objectKind DOES trip mixedBoxSemantics (the old bug)", () => {
    // This is the OLD buggy behavior we're locking the regression for:
    // sam2-refine segment defaulted to absent (=> "object"), causing false mixed-semantics rejection
    const segs = [
      { id: "seg-0-10000", startTime: 0, endTime: 10, method: "yoloe+botsort", status: "ok", samples: [], objectKind: "face" },
      // sam2-refine without objectKind set (old behavior) — absent => "object"
      { id: "seg-sam2-refine-0", startTime: 0, endTime: 10, method: "sam2-refine", status: "ok", samples: [] },
    ] as never[];
    expect(mixedBoxSemantics(segs)).toBe(true);
  });

  it("object track + sam2-refine that inherited 'object' does NOT trip mixedBoxSemantics", () => {
    const segs = [
      { id: "seg-0-10000", startTime: 0, endTime: 10, method: "yoloe+botsort", status: "ok", samples: [] },
      { id: "seg-sam2-refine-0", startTime: 0, endTime: 10, method: "sam2-refine", status: "ok", samples: [], objectKind: "object" },
    ] as never[];
    expect(mixedBoxSemantics(segs)).toBe(false);
  });
});
