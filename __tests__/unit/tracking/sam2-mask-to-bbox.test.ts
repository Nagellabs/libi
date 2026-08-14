import { describe, it, expect } from "vitest";
import { maskToBbox, decodeCocoRle, type Mask } from "@/lib/tracking/sam2-mask-to-bbox";

// ---------------------------------------------------------------------------
// maskToBbox
// ---------------------------------------------------------------------------

describe("maskToBbox", () => {
  it("returns null for an all-zero mask", () => {
    const mask: Mask = { data: [0, 0, 0, 0, 0, 0, 0, 0, 0], width: 3, height: 3 };
    expect(maskToBbox(mask)).toBeNull();
  });

  it("returns null for an empty data array", () => {
    const mask: Mask = { data: [], width: 10, height: 10 };
    expect(maskToBbox(mask)).toBeNull();
  });

  it("returns null for invalid width", () => {
    const mask: Mask = { data: [1], width: -1, height: 1 };
    expect(maskToBbox(mask)).toBeNull();
  });

  it("returns null for invalid height", () => {
    const mask: Mask = { data: [1], width: 1, height: 0 };
    expect(maskToBbox(mask)).toBeNull();
  });

  it("returns null for NaN-only data", () => {
    const mask: Mask = { data: [NaN, NaN, NaN], width: 3, height: 1 };
    expect(maskToBbox(mask)).toBeNull();
  });

  it("returns null for Infinity values in data", () => {
    const mask: Mask = { data: [Infinity, 0, 0], width: 3, height: 1 };
    // Infinity is non-zero but fails the isFinite check → skipped
    expect(maskToBbox(mask)).toBeNull();
  });

  it("single rectangular blob — returns correct bbox", () => {
    // 5×5 mask with a 2×2 blob at (1,1)
    // Row-major: row 0: 0 0 0 0 0
    //            row 1: 0 1 1 0 0
    //            row 2: 0 1 1 0 0
    //            row 3: 0 0 0 0 0
    //            row 4: 0 0 0 0 0
    const data = [
      0, 0, 0, 0, 0,
      0, 1, 1, 0, 0,
      0, 1, 1, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
    ];
    const mask: Mask = { data, width: 5, height: 5 };
    const bbox = maskToBbox(mask);
    expect(bbox).not.toBeNull();
    expect(bbox!.x).toBe(1);
    expect(bbox!.y).toBe(1);
    expect(bbox!.w).toBe(2);
    expect(bbox!.h).toBe(2);
    expect(bbox!.confidence).toBeGreaterThan(0);
  });

  it("all-true mask — returns full-frame bbox", () => {
    const data = new Array(6).fill(1);
    const mask: Mask = { data, width: 3, height: 2 };
    const bbox = maskToBbox(mask);
    expect(bbox).not.toBeNull();
    expect(bbox!.x).toBe(0);
    expect(bbox!.y).toBe(0);
    expect(bbox!.w).toBe(3);
    expect(bbox!.h).toBe(2);
    expect(bbox!.confidence).toBeCloseTo(1);
  });

  it("single foreground pixel — returns 1×1 bbox", () => {
    // index 4 in a 3-wide grid: px = 4%3 = 1, py = floor(4/3) = 1 → (x=1, y=1)
    const data = [0, 0, 0, 0, 1, 0, 0, 0, 0];
    const mask: Mask = { data, width: 3, height: 3 };
    const bbox = maskToBbox(mask);
    expect(bbox).not.toBeNull();
    expect(bbox!.x).toBe(1);
    expect(bbox!.y).toBe(1);
    expect(bbox!.w).toBe(1);
    expect(bbox!.h).toBe(1);
  });

  it("multi-blob mask — returns tight bbox spanning both blobs", () => {
    // 7×1 mask: two blobs at positions 1 and 5
    const data = [0, 1, 0, 0, 0, 1, 0];
    const mask: Mask = { data, width: 7, height: 1 };
    const bbox = maskToBbox(mask);
    expect(bbox).not.toBeNull();
    // The tight bbox covers both blobs
    expect(bbox!.x).toBe(1);
    expect(bbox!.w).toBe(5); // from x=1 to x=5 → w = 5
  });

  it("edge-clipped blob touching frame boundary — bbox clamped within frame", () => {
    // 3×3 mask with blob at right/bottom edge
    const data = [
      0, 0, 0,
      0, 0, 1,
      0, 1, 1,
    ];
    const mask: Mask = { data, width: 3, height: 3 };
    const bbox = maskToBbox(mask);
    expect(bbox).not.toBeNull();
    expect(bbox!.x + bbox!.w).toBeLessThanOrEqual(3);
    expect(bbox!.y + bbox!.h).toBeLessThanOrEqual(3);
  });

  it("NaN in foreground data position — NaN value is skipped, non-NaN pixels produce bbox", () => {
    // pixel at (0,0) is 1, pixel at (1,0) is NaN (skipped), pixel at (2,0) is 1
    const data = [1, NaN, 1];
    const mask: Mask = { data, width: 3, height: 1 };
    // NaN pixels are skipped — result covers only valid pixels at x=0 and x=2
    const bbox = maskToBbox(mask);
    expect(bbox).not.toBeNull();
    // x=0, w should span from 0 to 2 → w=3
    expect(bbox!.x).toBe(0);
    expect(bbox!.w).toBe(3);
  });

  it("all-NaN data — returns null", () => {
    const mask: Mask = { data: [NaN, NaN], width: 2, height: 1 };
    expect(maskToBbox(mask)).toBeNull();
  });

  it("Uint8Array input works identically to number[]", () => {
    const data = new Uint8Array([0, 1, 0, 0, 1, 0, 0, 0, 0]);
    const mask: Mask = { data, width: 3, height: 3 };
    const bbox = maskToBbox(mask);
    expect(bbox).not.toBeNull();
    expect(bbox!.x).toBe(1);
    expect(bbox!.y).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// decodeCocoRle
// ---------------------------------------------------------------------------

describe("decodeCocoRle", () => {
  it("decodes a simple RLE and produces the correct row-major mask", () => {
    // 2×2 grid, COCO RLE column-major: [3, 1] means 3 background then 1 foreground
    // Column-major layout for a 2×2 (height=2, width=2):
    //   col0: [0,0]=[0,0], col1: [0,1]=[0,1]
    // [3, 1] → bg:3, fg:1 → pixels 0,1,2 are 0, pixel 3 is 1
    // pixel 3 in column-major: col=1, row=1 → row-major index = 1*2+1 = 3
    const mask = decodeCocoRle([3, 1], [2, 2]);
    expect(mask).not.toBeNull();
    expect(mask!.width).toBe(2);
    expect(mask!.height).toBe(2);
    // Only pixel at (row=1, col=1) should be foreground → row-major index 3
    expect(Array.from(mask!.data)).toEqual([0, 0, 0, 1]);
  });

  it("returns null for invalid size", () => {
    expect(decodeCocoRle([1], [0, 5])).toBeNull();
    expect(decodeCocoRle([1], [5, -1])).toBeNull();
    expect(decodeCocoRle([1], [NaN, 5])).toBeNull();
  });

  it("returns null for negative run in counts", () => {
    expect(decodeCocoRle([-1, 4], [2, 2])).toBeNull();
  });

  it("all-background RLE produces all-zero mask", () => {
    const mask = decodeCocoRle([4], [2, 2]);
    expect(mask).not.toBeNull();
    expect(Array.from(mask!.data)).toEqual([0, 0, 0, 0]);
  });

  it("all-foreground RLE (leading 0-run) produces all-one mask", () => {
    // counts=[0, 4]: 0 background, then 4 foreground
    const mask = decodeCocoRle([0, 4], [2, 2]);
    expect(mask).not.toBeNull();
    expect(Array.from(mask!.data)).toEqual([1, 1, 1, 1]);
  });
});
