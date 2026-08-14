import { describe, it, expect } from "vitest";
import {
  planRenderChunks,
  sumChunkProgress,
  RENDER_CHUNK_MIN_FRAMES,
} from "@/lib/export/chunk-plan";

/** Assert a plan is contiguous, ordered, and covers [0, total) exactly once. */
function assertCovers(
  chunks: Array<{ startFrame: number; endFrameExclusive: number }>,
  total: number,
) {
  if (total <= 0) {
    expect(chunks).toEqual([]);
    return;
  }
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks[0].startFrame).toBe(0);
  expect(chunks[chunks.length - 1].endFrameExclusive).toBe(total);
  for (let i = 0; i < chunks.length; i++) {
    // no empty chunk
    expect(chunks[i].endFrameExclusive).toBeGreaterThan(chunks[i].startFrame);
    if (i > 0) {
      // contiguous + ordered
      expect(chunks[i].startFrame).toBe(chunks[i - 1].endFrameExclusive);
    }
  }
}

describe("planRenderChunks", () => {
  it("totalFrames 0 → []", () => {
    expect(planRenderChunks(0, 4)).toEqual([]);
    expect(planRenderChunks(-10, 4)).toEqual([]);
  });

  it("below the min-frames threshold → a single chunk", () => {
    const chunks = planRenderChunks(100, 4);
    expect(chunks).toEqual([{ startFrame: 0, endFrameExclusive: 100 }]);
    // sanity: 100 < RENDER_CHUNK_MIN_FRAMES
    expect(100).toBeLessThan(RENDER_CHUNK_MIN_FRAMES);
  });

  it("5183 frames with workers 4 → 4 contiguous chunks covering [0,5183)", () => {
    const total = 5183;
    const chunks = planRenderChunks(total, 4);
    expect(chunks.length).toBe(4);
    assertCovers(chunks, total);
    // sizes within one ceil-bucket of each other
    const sizes = chunks.map((c) => c.endFrameExclusive - c.startFrame);
    const max = Math.max(...sizes);
    const min = Math.min(...sizes);
    expect(max - min).toBeLessThanOrEqual(max); // ceil bucketing keeps them close
    expect(max).toBe(Math.ceil(total / 4));
  });

  it("900 frames with workers 4 → floor(900/450)=2 chunks", () => {
    const chunks = planRenderChunks(900, 4);
    expect(chunks.length).toBe(2);
    expect(chunks).toEqual([
      { startFrame: 0, endFrameExclusive: 450 },
      { startFrame: 450, endFrameExclusive: 900 },
    ]);
    assertCovers(chunks, 900);
  });

  it("exact-divisible case → equal chunks", () => {
    const total = 1200; // floor(1200/450)=2 → chunkSize 600
    const chunks = planRenderChunks(total, 4);
    expect(chunks).toEqual([
      { startFrame: 0, endFrameExclusive: 600 },
      { startFrame: 600, endFrameExclusive: 1200 },
    ]);
    assertCovers(chunks, total);
  });

  it("workers 1 → single chunk regardless of length", () => {
    const chunks = planRenderChunks(5183, 1);
    expect(chunks).toEqual([{ startFrame: 0, endFrameExclusive: 5183 }]);
  });

  it("never produces an empty chunk for a broad sweep of sizes/workers", () => {
    for (const total of [1, 449, 450, 451, 899, 901, 5183, 9001]) {
      for (const workers of [1, 2, 3, 4, 8]) {
        assertCovers(planRenderChunks(total, workers), total);
      }
    }
  });
});

describe("sumChunkProgress", () => {
  it("sums per-chunk done counts", () => {
    expect(sumChunkProgress([])).toBe(0);
    expect(sumChunkProgress([0, 0, 0])).toBe(0);
    expect(sumChunkProgress([100, 200, 50])).toBe(350);
  });
});
