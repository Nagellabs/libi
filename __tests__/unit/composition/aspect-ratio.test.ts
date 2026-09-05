import { describe, it, expect } from "vitest";
import {
  ASPECT_RATIOS,
  DEFAULT_ASPECT_RATIO_ID,
  orientationOf,
  nearestRatio,
  dimensionsFor,
  ratioById,
  describeRatio,
} from "@/lib/composition/aspect-ratio";

describe("ASPECT_RATIOS catalog", () => {
  it("offers exactly the six agreed ratios", () => {
    expect(ASPECT_RATIOS.map((r) => r.id)).toEqual([
      "9:16",
      "4:5",
      "1:1",
      "16:9",
      "4:3",
      "21:9",
    ]);
  });

  it("derives every dimension from a 1080 short edge, and all are even", () => {
    // H.264 yuv420p requires even dimensions; an odd one fails at encode time,
    // which is far from where the catalog is edited.
    for (const r of ASPECT_RATIOS) {
      const d = dimensionsFor(r.id)!;
      expect(Math.min(d.width, d.height)).toBe(1080);
      expect(d.width % 2).toBe(0);
      expect(d.height % 2).toBe(0);
    }
  });

  it("maps each entry to the expected pixel dimensions", () => {
    expect(dimensionsFor("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(dimensionsFor("4:5")).toEqual({ width: 1080, height: 1350 });
    expect(dimensionsFor("1:1")).toEqual({ width: 1080, height: 1080 });
    expect(dimensionsFor("16:9")).toEqual({ width: 1920, height: 1080 });
    expect(dimensionsFor("4:3")).toEqual({ width: 1440, height: 1080 });
    expect(dimensionsFor("21:9")).toEqual({ width: 2520, height: 1080 });
  });

  it("labels each entry's orientation consistently with its own w/h", () => {
    for (const r of ASPECT_RATIOS) {
      expect(r.orientation).toBe(orientationOf(r.w, r.h));
    }
  });

  it("defaults to portrait 9:16", () => {
    expect(DEFAULT_ASPECT_RATIO_ID).toBe("9:16");
    expect(ratioById(DEFAULT_ASPECT_RATIO_ID)!.orientation).toBe("portrait");
  });

  it("returns null for an unknown id rather than throwing", () => {
    expect(dimensionsFor("7:3")).toBeNull();
    expect(ratioById("nope")).toBeNull();
  });
});

describe("orientationOf", () => {
  it("classifies the three cases", () => {
    expect(orientationOf(1920, 1080)).toBe("landscape");
    expect(orientationOf(1080, 1920)).toBe("portrait");
    expect(orientationOf(1080, 1080)).toBe("square");
  });

  it("treats a non-positive dimension as landscape rather than throwing", () => {
    // Callers pass manifest values straight through; a corrupt manifest must
    // not crash the Preview row.
    expect(orientationOf(0, 0)).toBe("landscape");
    expect(orientationOf(-1, 100)).toBe("landscape");
  });
});

describe("nearestRatio", () => {
  it("matches exact catalog dimensions", () => {
    expect(nearestRatio(1920, 1080)!.id).toBe("16:9");
    expect(nearestRatio(1080, 1920)!.id).toBe("9:16");
    expect(nearestRatio(1080, 1080)!.id).toBe("1:1");
  });

  it("absorbs real-world rounding within 2%", () => {
    // A 1912x1080 crop is still 16:9 to a human; 1.7704 vs 1.7778 is 0.4%.
    expect(nearestRatio(1912, 1080)!.id).toBe("16:9");
    expect(nearestRatio(576, 1024)!.id).toBe("9:16");
  });

  it("returns null for a shape no catalog entry is close to", () => {
    // 16:10 (1.600) is 10% from 16:9 (1.778) — a genuinely different shape.
    // Snapping it to 16:9 would mislabel the Preview row.
    expect(nearestRatio(1920, 1200)).toBeNull();
    expect(nearestRatio(1000, 1400)).toBeNull();
  });

  it("returns null for non-positive input", () => {
    expect(nearestRatio(0, 1080)).toBeNull();
    expect(nearestRatio(1920, 0)).toBeNull();
  });
});

describe("describeRatio", () => {
  it("uses the catalog id when one matches", () => {
    expect(describeRatio(1920, 1080)).toBe("16:9");
  });

  it("falls back to explicit pixels for a custom shape", () => {
    // The agent can set any dimensions; the label must stay truthful rather
    // than claiming the nearest catalog entry.
    expect(describeRatio(1000, 1400)).toBe("1000x1400");
  });
});
