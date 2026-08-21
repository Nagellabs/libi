import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { classifyExportShape } from "@/lib/export/classifier";
import type { Composition, Overlay } from "@/lib/engine/types";

/** A full-frame code overlay — a JS draw fn the ffmpeg graph cannot run, which
 *  is what forces the chromium path. */
function mkOverlay(overrides: Partial<Overlay> = {}): Overlay {
  return {
    id: "s1",
    kind: "code",
    startTime: 0,
    duration: 1,
    z: 0,
    opacity: 1,
    rect: { x: 0, y: 0, width: 1920, height: 1080 },
    drawFunction: "() => {}",
    ...overrides,
  } as Overlay;
}

function mkComp(overrides: Partial<Composition> = {}): Composition {
  return {
    id: "c1",
    width: 1920,
    height: 1080,
    fps: 30,
    overlays: [mkOverlay()],
    ...overrides,
  } as Composition;
}

describe("classifier — chromium-render shape", () => {
  const originalFlag = process.env.LIBI_EXPORT_USE_BROWSER_CANVAS;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.LIBI_EXPORT_USE_BROWSER_CANVAS;
    else process.env.LIBI_EXPORT_USE_BROWSER_CANVAS = originalFlag;
  });

  it("emits chromium-render for a code overlay", () => {
    expect(classifyExportShape(mkComp())).toEqual({ tag: "chromium-render" });
  });

  it("emits chromium-render for a composition of code overlays", () => {
    const comp = mkComp({ overlays: [mkOverlay({ id: "a" }), mkOverlay({ id: "b" })] });
    expect(classifyExportShape(comp)).toEqual({ tag: "chromium-render" });
  });

  it("falls back to canvas-source when LIBI_EXPORT_USE_BROWSER_CANVAS=1", () => {
    process.env.LIBI_EXPORT_USE_BROWSER_CANVAS = "1";
    expect(classifyExportShape(mkComp())).toEqual({ tag: "canvas-source" });
  });
});
