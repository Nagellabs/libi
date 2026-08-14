import { describe, it, expect } from "vitest";
import { chunkFrameMeta } from "@/lib/engine/export-frame-range";

describe("chunkFrameMeta", () => {
  const fps = 30;

  it("a full-composition range starts at t=0 on the first frame", () => {
    const range = { startFrame: 0, endFrameExclusive: 300 };
    expect(chunkFrameMeta(0, range, fps)).toEqual({
      timestamp: 0,
      progress: 1 / 300,
    });
  });

  it("a mid-composition chunk resets the encoder timestamp to chunk-local", () => {
    // Chunk covering frames [1296, 2592) — 1296 frames.
    const range = { startFrame: 1296, endFrameExclusive: 2592 };
    // First frame of the chunk → local frame 0 → timestamp 0.
    expect(chunkFrameMeta(1296, range, fps).timestamp).toBe(0);
    // 30 frames in → 1 second of chunk-local time.
    expect(chunkFrameMeta(1296 + 30, range, fps).timestamp).toBeCloseTo(1, 10);
  });

  it("progress is chunk-local and reaches 1 on the last frame", () => {
    const range = { startFrame: 100, endFrameExclusive: 130 }; // 30 frames
    expect(chunkFrameMeta(100, range, fps).progress).toBeCloseTo(1 / 30, 10);
    expect(chunkFrameMeta(115, range, fps).progress).toBeCloseTo(16 / 30, 10);
    // last frame (index 129) → local 29 → (29+1)/30 = 1
    expect(chunkFrameMeta(129, range, fps).progress).toBeCloseTo(1, 10);
  });

  it("degenerate zero-length range reports progress 1 without dividing by zero", () => {
    const range = { startFrame: 50, endFrameExclusive: 50 };
    expect(chunkFrameMeta(50, range, fps).progress).toBe(1);
  });
});
