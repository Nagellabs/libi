import { describe, it, expect } from "vitest";
import { manualAnchorId, upsertManualAnchor, removeManualAnchor } from "@/lib/tracking/manual-anchors";
import type { ManualAnchor } from "@/lib/tracking/types";

describe("manual-anchor crud helpers", () => {
  it("manualAnchorId is deterministic from time", () => {
    expect(manualAnchorId(1.5)).toBe("man-1500");
    expect(manualAnchorId(0)).toBe("man-0");
  });

  it("upsert replaces an anchor at the same time, sorts by time", () => {
    const a: ManualAnchor = { id: "man-1000", time: 1, bbox: [0, 0, 1, 1] };
    const b: ManualAnchor = { id: "man-1000", time: 1, bbox: [5, 5, 2, 2] };
    const c: ManualAnchor = { id: "man-500", time: 0.5, bbox: [9, 9, 3, 3] };
    let out = upsertManualAnchor([], a);
    out = upsertManualAnchor(out, c);
    out = upsertManualAnchor(out, b); // replaces a (same id)
    expect(out).toEqual([c, b]);
  });

  it("remove drops by id and is a no-op for unknown id", () => {
    const a: ManualAnchor = { id: "man-1000", time: 1, bbox: [0, 0, 1, 1] };
    expect(removeManualAnchor([a], "man-1000")).toEqual([]);
    expect(removeManualAnchor([a], "nope")).toEqual([a]);
  });
});
