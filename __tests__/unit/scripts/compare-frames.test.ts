/**
 * The batching contract for `/api/render/frames`.
 *
 * That route does `body.atTimes?.slice(0, 8)` — a SILENT truncation, not an
 * error. A caller that hands it 12 timestamps gets 8 frames back and no
 * indication the other 4 were dropped, which in a before/after comparison
 * reads as "those frames were fine". Hence the batching, and hence this test.
 */
import { describe, it, expect } from "vitest";
import { batchTimes, frameFilename, MAX_TIMES_PER_REQUEST } from "@/scripts/compare-frames";

describe("batchTimes", () => {
  it("never exceeds the route's per-request cap", () => {
    expect(MAX_TIMES_PER_REQUEST).toBe(8);
    const batches = batchTimes([1, 3, 5, 8, 12, 17, 22, 25, 27, 29, 35, 45]);
    expect(batches.map((b) => b.length)).toEqual([8, 4]);
    expect(batches.flat()).toHaveLength(12);
  });

  it("keeps every timestamp, in order", () => {
    const times = Array.from({ length: 20 }, (_, i) => i);
    expect(batchTimes(times).flat()).toEqual(times);
  });

  it("handles a set that fits in one request", () => {
    expect(batchTimes([1, 2, 3])).toEqual([[1, 2, 3]]);
  });
});

describe("frameFilename", () => {
  it("pairs a baseline and a candidate by timestamp", () => {
    expect(frameFilename(1)).toBe("frame-1000ms.png");
    expect(frameFilename(26.5)).toBe("frame-26500ms.png");
  });
});
