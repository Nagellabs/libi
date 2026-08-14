import { describe, it, expect } from "vitest";
import { maxOverlap } from "@/lib/audio/overlap";
import type { AudioClip } from "@/lib/engine/types";

const clip = (id: string, startTime: number, duration: number): AudioClip => ({
  id, kind: "standalone", fileId: "f", startTime, duration, trimStart: 0, volume: 1, enabled: true,
});

describe("maxOverlap", () => {
  it("returns 0 for an empty list", () => {
    expect(maxOverlap([])).toBe(0);
  });
  it("returns 1 for non-overlapping clips", () => {
    expect(maxOverlap([clip("a", 0, 5), clip("b", 5, 5), clip("c", 10, 5)])).toBe(1);
  });
  it("returns the peak count when multiple overlap", () => {
    // Three clips overlap between t=4 and t=5.
    expect(maxOverlap([clip("a", 0, 5), clip("b", 3, 5), clip("c", 4, 5)])).toBe(3);
  });
  it("handles end == next start as no overlap", () => {
    expect(maxOverlap([clip("a", 0, 5), clip("b", 5, 5)])).toBe(1);
  });
});
