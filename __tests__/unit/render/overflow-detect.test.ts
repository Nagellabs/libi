import { describe, it, expect } from "vitest";
import { detectEdgeOverflow } from "@/lib/render/overflow-detect";

/** Build a W×H RGBA buffer, all dark (0,0,0,255), then paint a bright band. */
function makeBuffer(w: number, h: number, paint?: (set: (x: number, y: number) => void) => void) {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) buf[i * 4 + 3] = 255; // opaque black
  const set = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = 255;
  };
  if (paint) paint(set);
  return buf;
}

describe("detectEdgeOverflow", () => {
  it("flags the right edge when bright pixels line the right border", () => {
    const w = 64, h = 48;
    const buf = makeBuffer(w, h, (set) => {
      for (let y = 0; y < h; y++) { set(w - 1, y); set(w - 2, y); }
    });
    const r = detectEdgeOverflow(buf, w, h);
    expect(r.touchesEdge).toBe(true);
    expect(r.edges).toContain("right");
    expect(r.edges).not.toContain("left");
  });

  it("returns false for an all-dark buffer", () => {
    const w = 64, h = 48;
    const buf = makeBuffer(w, h);
    const r = detectEdgeOverflow(buf, w, h);
    expect(r.touchesEdge).toBe(false);
    expect(r.edges).toEqual([]);
  });

  it("flags top and bottom independently", () => {
    const w = 40, h = 40;
    const buf = makeBuffer(w, h, (set) => {
      for (let x = 0; x < w; x++) { set(x, 0); set(x, h - 1); }
    });
    const r = detectEdgeOverflow(buf, w, h);
    expect(r.edges.sort()).toEqual(["bottom", "top"]);
  });

  it("ignores a small number of stray bright pixels below the count threshold", () => {
    const w = 100, h = 100;
    const buf = makeBuffer(w, h, (set) => { set(w - 1, 50); }); // a single bright pixel on the right edge
    const r = detectEdgeOverflow(buf, w, h);
    expect(r.touchesEdge).toBe(false);
  });
});
