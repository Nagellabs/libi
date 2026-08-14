import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { classifyExportShape } from "@/lib/export/classifier";
import type { Composition, CanvasScene } from "@/lib/engine/types";

function mkCanvasScene(overrides: Partial<CanvasScene> = {}): CanvasScene {
  return {
    id: "s1",
    type: "canvas",
    durationInFrames: 30,
    drawFunction: "() => {}",
    ...overrides,
  } as CanvasScene;
}

function mkComp(overrides: Partial<Composition> = {}): Composition {
  return {
    id: "c1",
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: [mkCanvasScene()],
    overlays: [],
    ...overrides,
  } as Composition;
}

describe("classifier — chromium-render shape", () => {
  const originalFlag = process.env.LIBI_EXPORT_USE_BROWSER_CANVAS;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.LIBI_EXPORT_USE_BROWSER_CANVAS;
    else process.env.LIBI_EXPORT_USE_BROWSER_CANVAS = originalFlag;
  });

  it("emits chromium-render for a canvas scene", () => {
    expect(classifyExportShape(mkComp())).toEqual({ tag: "chromium-render" });
  });

  it("emits chromium-render for multi-scene compositions", () => {
    const comp = mkComp({ scenes: [mkCanvasScene({ id: "a" }), mkCanvasScene({ id: "b" })] });
    expect(classifyExportShape(comp)).toEqual({ tag: "chromium-render" });
  });

  it("falls back to canvas-source when LIBI_EXPORT_USE_BROWSER_CANVAS=1", () => {
    process.env.LIBI_EXPORT_USE_BROWSER_CANVAS = "1";
    expect(classifyExportShape(mkComp())).toEqual({ tag: "canvas-source" });
  });
});
