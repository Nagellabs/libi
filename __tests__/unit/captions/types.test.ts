// __tests__/unit/captions/types.test.ts
import { describe, it, expect } from "vitest";
import type { CaptionGroupRef, CaptionAnchor } from "@/lib/captions/types";

describe("caption types", () => {
  it("CaptionGroupRef defaults useTrackStyle true by construction convention", () => {
    const ref: CaptionGroupRef = { groupId: "g1", useTrackStyle: true };
    expect(ref.useTrackStyle).toBe(true);
  });
  it("CaptionAnchor includes the 9 numpad cells", () => {
    const anchors: CaptionAnchor[] = [
      "top-left","top-center","top-right","mid-left","mid-center","mid-right","bottom-left","bottom-center","bottom-right",
    ];
    expect(anchors).toHaveLength(9);
  });
});
