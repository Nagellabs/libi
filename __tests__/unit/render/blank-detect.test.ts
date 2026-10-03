import { describe, it, expect } from "vitest";
import { isBlankFrame } from "@/lib/render/blank-detect";

function frame(w: number, h: number, rgb: [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = rgb[0];
    d[i * 4 + 1] = rgb[1];
    d[i * 4 + 2] = rgb[2];
    d[i * 4 + 3] = 255;
  }
  return d;
}

function paintRect(d: Uint8ClampedArray, w: number, x0: number, y0: number, rw: number, rh: number, rgb: [number, number, number]) {
  for (let y = y0; y < y0 + rh; y++)
    for (let x = x0; x < x0 + rw; x++) {
      const i = (y * w + x) * 4;
      d[i] = rgb[0];
      d[i + 1] = rgb[1];
      d[i + 2] = rgb[2];
    }
}

describe("isBlankFrame", () => {
  const W = 320;
  const H = 180;

  it("a flat frame is blank, whatever the colour", () => {
    expect(isBlankFrame(frame(W, H, [0, 0, 0]), W, H)).toBe(true);
    expect(isBlankFrame(frame(W, H, [51, 102, 153]), W, H)).toBe(true);
  });

  it("sensor-level noise around the background is still blank", () => {
    const d = frame(W, H, [20, 20, 20]);
    for (let i = 0; i < W * H; i += 7) d[i * 4] = 24;
    expect(isBlankFrame(d, W, H)).toBe(true);
  });

  it("a frame with a visible element is not blank", () => {
    const d = frame(W, H, [0, 0, 0]);
    paintRect(d, W, 100, 60, 120, 40, [255, 255, 255]);
    expect(isBlankFrame(d, W, H)).toBe(false);
  });

  it("a small but legible element (a 20 px icon) is not blank", () => {
    const d = frame(W, H, [0, 0, 0]);
    paintRect(d, W, 10, 10, 20, 20, [255, 0, 0]);
    expect(isBlankFrame(d, W, H)).toBe(false);
  });

  it("a speck of a few pixels (2x2) is still blank", () => {
    const d = frame(W, H, [0, 0, 0]);
    paintRect(d, W, 10, 10, 2, 2, [255, 255, 255]);
    expect(isBlankFrame(d, W, H)).toBe(true);
  });

  it("a mostly-covered frame (the element IS the background) is not blank when a minority differs", () => {
    const d = frame(W, H, [200, 30, 30]);
    paintRect(d, W, 0, 0, W, 60, [0, 0, 0]);
    expect(isBlankFrame(d, W, H)).toBe(false);
  });

  it("an empty or undersized buffer is never called blank", () => {
    expect(isBlankFrame(new Uint8ClampedArray(0), 0, 0)).toBe(false);
    expect(isBlankFrame(new Uint8ClampedArray(8), 100, 100)).toBe(false);
  });
});
