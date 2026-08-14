/**
 * A video overlay honors its `fit`: "cover" fills the rect (cropping overflow,
 * clipped to the rect) and "contain" letterboxes. Asserts the drawImage
 * destination rect the renderer computes for a wide source in a square rect.
 */
import { describe, it, expect } from "vitest";
import { drawOverlayContent2D } from "@/lib/engine/overlay-renderer";

type DrawCall = { dx: number; dy: number; dw: number; dh: number };

function recCtx() {
  const draws: DrawCall[] = [];
  let clipped = false;
  const obj = {
    draws,
    get clipped() { return clipped; },
    save() {}, restore() {},
    translate() {}, rotate() {}, scale() {},
    beginPath() {}, rect() {}, clip() { clipped = true; },
    clearRect() {},
    drawImage(_src: unknown, dx: number, dy: number, dw: number, dh: number) {
      draws.push({ dx, dy, dw, dh });
    },
    fillText() {}, fillRect() {}, strokeText() {},
    measureText() { return { width: 10 }; },
    globalAlpha: 1, filter: "none", fillStyle: "#000",
    textAlign: "left" as CanvasTextAlign, textBaseline: "alphabetic" as CanvasTextBaseline,
    font: "10px sans-serif",
    shadowColor: "transparent", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    strokeStyle: "#000", lineWidth: 1, imageSmoothingEnabled: true,
  };
  return obj as unknown as CanvasRenderingContext2D & { draws: DrawCall[]; clipped: boolean };
}

// A 200x100 (wide) source frame.
const frame = { videoWidth: 200, videoHeight: 100, width: 200, height: 100 };
function videoSource() {
  return { seek() {}, getFrame() { return frame as unknown as CanvasImageSource; } };
}

// 100x100 square rect — a wide source fits differently per mode.
const rect = { x: 0, y: 0, width: 100, height: 100 };

function drawWithFit(fit: "cover" | "contain" | undefined) {
  const overlay = {
    id: "v1", kind: "video", fileId: "f1", startTime: 0, duration: 5, z: 0, opacity: 1,
    rect, ...(fit ? { fit } : {}),
  } as never;
  const ctx = recCtx();
  drawOverlayContent2D(
    overlay,
    { ctx, time: 0, fps: 30, width: 100, height: 100, videoFrameSources: { v1: videoSource() } } as never,
    rect,
  );
  return ctx;
}

describe("video overlay fit", () => {
  it("'contain' letterboxes a wide source (full width, bars top/bottom)", () => {
    const ctx = drawWithFit("contain");
    expect(ctx.draws).toHaveLength(1);
    const d = ctx.draws[0];
    // 200x100 into 100x100 → width fills (100), height halves (50), vertical bars.
    expect(d.dw).toBe(100);
    expect(d.dh).toBe(50);
    expect(d.dy).toBe(25); // (100 - 50) / 2
  });

  it("'cover' fills the rect (height fills, overflow cropped/clipped)", () => {
    const ctx = drawWithFit("cover");
    expect(ctx.draws).toHaveLength(1);
    const d = ctx.draws[0];
    // 200x100 covering 100x100 → height fills (100), width overflows (200), horizontal crop.
    expect(d.dh).toBe(100);
    expect(d.dw).toBe(200);
    expect(d.dx).toBe(-50); // (100 - 200) / 2
    // Cover clips overflow to the rect.
    expect(ctx.clipped).toBe(true);
  });

  it("defaults to 'cover' when fit is unset", () => {
    const ctx = drawWithFit(undefined);
    const d = ctx.draws[0];
    expect(d.dh).toBe(100);
    expect(d.dw).toBe(200);
    expect(ctx.clipped).toBe(true);
  });
});
