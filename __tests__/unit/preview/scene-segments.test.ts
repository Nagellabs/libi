import { describe, it, expect } from "vitest";
import { sceneSegments } from "@/lib/preview/scene-segments";

describe("sceneSegments", () => {
  it("returns left/width percentages in frame space", () => {
    const segs = sceneSegments(
      [
        { id: "a", name: "A", duration: 2 },
        { id: "b", name: "B", duration: 1 },
      ],
      30,
      90,
    );
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ id: "a", name: "A", leftPct: 0 });
    expect(segs[0].widthPct).toBeCloseTo((60 / 90) * 100);
    expect(segs[1].leftPct).toBeCloseTo((60 / 90) * 100);
    expect(segs[1].widthPct).toBeCloseTo((30 / 90) * 100);
  });

  it("is degenerate-safe (0 total frames)", () => {
    const segs = sceneSegments([{ id: "a", name: "A", duration: 2 }], 30, 0);
    expect(segs[0]).toMatchObject({ id: "a", leftPct: 0, widthPct: 0 });
  });
});
