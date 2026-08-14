// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay, DrawContext } from "@/lib/engine/types";

function recCtx() {
  const translates: Array<[number, number]> = [];
  const scales: Array<[number, number]> = [];
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn((x: number, y: number) => translates.push([x, y])),
    scale: vi.fn((x: number, y: number) => scales.push([x, y])),
    rotate: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    fillStyle: "#000",
    filter: "none",
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, translates, scales };
}

function codeOverlay(rect: { x: number; y: number; width: number; height: number }): Overlay {
  return {
    id: "ov",
    kind: "code",
    startTime: 0,
    duration: 3,
    z: 1,
    opacity: 1,
    rect,
    drawFunction: "/* injected */",
  };
}

describe("code overlay content contain-fit (renderer)", () => {
  it("scales UP and centers a fixed-size graphic into a larger rect", () => {
    const { ctx, translates, scales } = recCtx();
    let seen: DrawContext | null = null;
    const overlay = codeOverlay({ x: 10, y: 20, width: 400, height: 200 });
    drawOverlay(overlay, {
      ctx, width: 1920, height: 1080, fps: 30, frame: 0, time: 0, totalFrames: 90,
      assets: {},
      compiledDrawFns: { ov: (c) => { seen = c as DrawContext; } },
      // 100x100 content box → scale 2, dx 100, dy 0 (derived in the pure test).
      codeContentBoxes: { ov: { x: 0, y: 0, width: 100, height: 100 } },
    } as DrawOverlayContext);

    // Origin translate then fit translate; scale applied once.
    expect(translates).toContainEqual([10, 20]); // rect origin
    expect(translates).toContainEqual([100, 0]); // fit dx,dy
    expect(scales).toContainEqual([2, 2]);
    // The fn STILL receives rect-space width/height (unchanged contract).
    expect(seen!.width).toBe(400);
    expect(seen!.height).toBe(200);
  });

  it("is byte-identical (identity) when the content fills the rect", () => {
    const { ctx, translates, scales } = recCtx();
    const overlay = codeOverlay({ x: 10, y: 20, width: 400, height: 200 });
    drawOverlay(overlay, {
      ctx, width: 1920, height: 1080, fps: 30, frame: 0, time: 0, totalFrames: 90,
      assets: {},
      compiledDrawFns: { ov: () => {} },
      // Box == rect → contentFitOps identity → renderer must NOT emit fit ops.
      codeContentBoxes: { ov: { x: 0, y: 0, width: 400, height: 200 } },
    } as DrawOverlayContext);

    // Only the rect-origin translate; no fit translate, no scale.
    expect(translates).toEqual([[10, 20]]);
    expect(scales).toEqual([]);
  });

  it("falls back to identity when no box is present", () => {
    const { ctx, translates, scales } = recCtx();
    const overlay = codeOverlay({ x: 10, y: 20, width: 400, height: 200 });
    drawOverlay(overlay, {
      ctx, width: 1920, height: 1080, fps: 30, frame: 0, time: 0, totalFrames: 90,
      assets: {},
      compiledDrawFns: { ov: () => {} },
      // No codeContentBoxes map at all.
    } as DrawOverlayContext);

    expect(translates).toEqual([[10, 20]]);
    expect(scales).toEqual([]);
  });

  it("falls back to identity for a degenerate (null) box", () => {
    const { ctx, translates, scales } = recCtx();
    const overlay = codeOverlay({ x: 10, y: 20, width: 400, height: 200 });
    drawOverlay(overlay, {
      ctx, width: 1920, height: 1080, fps: 30, frame: 0, time: 0, totalFrames: 90,
      assets: {},
      compiledDrawFns: { ov: () => {} },
      codeContentBoxes: { ov: null },
    } as DrawOverlayContext);

    expect(translates).toEqual([[10, 20]]);
    expect(scales).toEqual([]);
  });
});
