import { describe, it, expect } from "vitest";
import { drawOverlayContent2D, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { ImageOverlay, TextOverlay } from "@/lib/engine/types";

function recCtx() {
  const calls: string[] = [];
  let _font = "10px sans-serif";
  const obj = {
    calls,
    save() { calls.push("save"); }, restore() { calls.push("restore"); },
    translate() {}, rotate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
    drawImage() { calls.push("drawImage"); }, clearRect() { calls.push("clearRect"); },
    fillText() { calls.push("fillText"); }, fillRect() {}, strokeText() {},
    measureText() { return { width: 10 }; },
    globalAlpha: 1, filter: "none", fillStyle: "#000", textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    get font() { return _font; },
    set font(v: string) { _font = v; },
    shadowColor: "transparent", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    strokeStyle: "#000", lineWidth: 1,
    imageSmoothingEnabled: true,
  };
  return obj as unknown as CanvasRenderingContext2D & { calls: string[] };
}

describe("drawOverlayContent2D", () => {
  it("renders an image overlay's element via drawImage at the local rect", () => {
    const img = { naturalWidth: 100, naturalHeight: 100, width: 100, height: 100 } as unknown as HTMLImageElement;
    const overlay: ImageOverlay = {
      id: "i1", kind: "image", fileId: "f1", startTime: 0, duration: 5, z: 0, opacity: 1,
      rect: { x: 0, y: 0, width: 100, height: 100 },
    };
    const ctx = recCtx();
    const drawCtx: DrawOverlayContext = {
      ctx, time: 0, frame: 0, totalFrames: 150, fps: 30, width: 100, height: 100,
      assets: {}, imageElements: { i1: img },
    };
    drawOverlayContent2D(overlay, drawCtx, { x: 0, y: 0, width: 100, height: 100 });
    expect(ctx.calls).toContain("drawImage");
  });

  it("renders a text overlay's glyphs via fillText", () => {
    const overlay: TextOverlay = {
      id: "t1", kind: "text", content: "Hi", font: "20px Inter", color: "#fff", align: "left",
      startTime: 0, duration: 5, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 100, height: 40 },
    };
    const ctx = recCtx();
    const drawCtx: DrawOverlayContext = {
      ctx, time: 0, frame: 0, totalFrames: 150, fps: 30, width: 100, height: 40, assets: {},
    };
    drawOverlayContent2D(overlay, drawCtx, { x: 0, y: 0, width: 100, height: 40 });
    expect(ctx.calls).toContain("fillText");
  });
});
