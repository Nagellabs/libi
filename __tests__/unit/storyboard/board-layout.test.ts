import { describe, it, expect } from "vitest";
import { gridLayout, type GridItem } from "@/lib/storyboard/board-layout";

function items(n: number, w = 420, h = 480): GridItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    order: i,
    width: w,
    height: h,
  }));
}

describe("gridLayout", () => {
  it("returns an empty map for no items", () => {
    expect(gridLayout([])).toEqual({});
  });

  it("places a single item at the origin", () => {
    expect(gridLayout(items(1))).toEqual({ c0: { x: 0, y: 0 } });
  });

  it("wraps 5 items into a 3×2 grid (two lines)", () => {
    const pos = gridLayout(items(5), { colGap: 60, rowGap: 60 });
    // cols = ceil(sqrt(5)) = 3 → row 0: c0,c1,c2 ; row 1: c3,c4
    expect(pos.c0.y).toBe(0);
    expect(pos.c1.y).toBe(0);
    expect(pos.c2.y).toBe(0);
    expect(pos.c3.y).toBe(540); // 480 + 60
    expect(pos.c4.y).toBe(540);
    // distinct columns in reading order on the first row
    expect(pos.c0.x).toBe(0);
    expect(pos.c1.x).toBe(480); // 420 + 60
    expect(pos.c2.x).toBe(960);
    // second row restarts at column 0
    expect(pos.c3.x).toBe(0);
    expect(pos.c4.x).toBe(480);
  });

  it("lays 4 items out as a 2×2 grid", () => {
    const pos = gridLayout(items(4));
    expect(pos.c0.y).toBe(pos.c1.y);
    expect(pos.c2.y).toBe(pos.c3.y);
    expect(pos.c2.y).toBeGreaterThan(pos.c0.y);
    expect(pos.c0.x).toBe(pos.c2.x); // same column
    expect(pos.c1.x).toBe(pos.c3.x);
  });

  it("orders by `order`, not array position", () => {
    const shuffled: GridItem[] = [
      { id: "b", order: 1, width: 420, height: 480 },
      { id: "a", order: 0, width: 420, height: 480 },
      { id: "c", order: 2, width: 420, height: 480 },
      { id: "d", order: 3, width: 420, height: 480 },
    ];
    const pos = gridLayout(shuffled);
    // cols = 2 → a,b on row 0; c,d on row 1
    expect(pos.a).toEqual({ x: 0, y: 0 });
    expect(pos.b.x).toBeGreaterThan(pos.a.x);
    expect(pos.b.y).toBe(0);
    expect(pos.c.y).toBeGreaterThan(0);
  });

  it("packs rows by the tallest item so variable heights never overlap", () => {
    const mixed: GridItem[] = [
      { id: "tall", order: 0, width: 420, height: 800 },
      { id: "short", order: 1, width: 420, height: 200 },
      { id: "next", order: 2, width: 420, height: 300 },
    ];
    // cols = ceil(sqrt(3)) = 2 → row 0: tall,short ; row 1: next
    const pos = gridLayout(mixed, { rowGap: 60, colGap: 60 });
    expect(pos.next.y).toBe(860); // tallest of row 0 (800) + gap (60)
  });

  it("widens a column to its widest member", () => {
    const wideMix: GridItem[] = [
      { id: "a", order: 0, width: 420, height: 480 },
      { id: "b", order: 1, width: 600, height: 480 },
      { id: "c", order: 2, width: 420, height: 480 }, // shares column with a
    ];
    // cols = 2 → col 0: a,c (max width 420) ; col 1: b (width 600)
    const pos = gridLayout(wideMix, { colGap: 60 });
    expect(pos.b.x).toBe(480); // 420 + 60
    expect(pos.c.x).toBe(0); // back to column 0
  });
});
