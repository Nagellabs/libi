import { describe, it, expect, vi } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay } from "@/lib/engine/types";
import type { Track } from "@/lib/tracking/types";
import { fakeBitmap, fakeLayers } from "@/__tests__/helpers/fake-layers";

function mockCtx() {
  return {
    save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(),
    drawImage: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), setTransform: vi.fn(),
    globalAlpha: 1, filter: "none",
  } as unknown as CanvasRenderingContext2D;
}
const base = (ctx: CanvasRenderingContext2D, layers: DrawOverlayContext["layers"]): DrawOverlayContext => ({
  ctx, width: 1920, height: 1080, fps: 30, frame: 30, time: 1, totalFrames: 60, assets: {}, renderScale: 2, layers,
});

describe("drawOverlay with a LayerSource", () => {
  it("code: requests the frame, clips to the rect and draws the newest bitmap at the rect", () => {
    const overlay = { id: "c", kind: "code", startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 10, y: 20, width: 300, height: 150 }, drawFunction: "" } as unknown as Overlay;
    const bmp = fakeBitmap();
    const layers = fakeLayers({ c: bmp });
    const ctx = mockCtx();
    drawOverlay(overlay, base(ctx, layers));
    expect(layers.requests).toHaveLength(1);
    expect(layers.requests[0]).toMatchObject({ overlayId: "c", kind: "code", frame: 30, pixelRatio: 2, size: { width: 300, height: 150 } });
    expect(ctx.clip).toHaveBeenCalled();
    // The source rect names the layer's device px, so the draw is 1:1 (review M1).
    expect(ctx.drawImage).toHaveBeenCalledWith(bmp, 0, 0, 600, 300, 10, 20, 300, 150);
  });
  it("code: no bitmap yet → requests but draws nothing, and never throws", () => {
    const overlay = { id: "c", kind: "code", startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, drawFunction: "" } as unknown as Overlay;
    const layers = fakeLayers();
    const ctx = mockCtx();
    expect(() => drawOverlay(overlay, base(ctx, layers))).not.toThrow();
    expect(layers.requests).toHaveLength(1);
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });
  it("three: draws at the rect, rolling about its center when rotation.z is set", () => {
    const overlay = {
      id: "t", kind: "three", startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 120, y: 60, width: 400, height: 300 }, sceneFunction: "",
      transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0.5 } },
    } as unknown as Overlay;
    const bmp = fakeBitmap();
    const layers = fakeLayers({ t: bmp });
    const ctx = mockCtx();
    drawOverlay(overlay, base(ctx, layers));
    expect(layers.requests[0].transform3d).toEqual({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } });
    expect(ctx.rotate).toHaveBeenCalledWith(0.5);
    expect(ctx.translate).toHaveBeenCalledWith(320, 210);
    expect(ctx.drawImage).toHaveBeenCalledWith(bmp, 0, 0, 800, 600, 120, 60, 400, 300);
  });
  it("code with a fractional rect: whole-px layer, sub-pixel position kept (review M1)", () => {
    const overlay = { id: "c", kind: "code", startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 10.25, y: 20.5, width: 99.6, height: 50.2 }, drawFunction: "" } as unknown as Overlay;
    const bmp = fakeBitmap();
    const layers = fakeLayers({ c: bmp });
    const ctx = mockCtx();
    drawOverlay(overlay, base(ctx, layers));
    expect(layers.requests[0].size).toEqual({ width: 100, height: 50 });
    expect(ctx.drawImage).toHaveBeenCalledWith(bmp, 0, 0, 200, 100, 10.25, 20.5, 100, 50);
  });
  it("tracked code: draws the padded layer at the bbox minus the pad, with no clip (review I1)", () => {
    const track: Track = {
      id: "trk", fileId: "f", method: "mediapipe-face", framerate: 30, durationSec: 2,
      samples: [
        { t: 0, x: 100, y: 200, w: 50, h: 60, confidence: 0.9, visible: true },
        { t: 2, x: 100, y: 200, w: 50, h: 60, confidence: 0.9, visible: true },
      ],
    };
    const overlay = {
      id: "k", kind: "tracked", trackId: "trk", startTime: 0, duration: 2, z: 0, opacity: 1,
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, fit: "tight", scale: 1, smoothing: "linear",
      content: { kind: "code", drawFunction: "" },
    } as unknown as Overlay;
    const bmp = fakeBitmap();
    const layers = fakeLayers({ k: bmp });
    const ctx = mockCtx();
    drawOverlay(overlay, { ...base(ctx, layers), tracks: { trk: track } });
    expect(layers.requests[0]).toMatchObject({ kind: "tracked", size: { width: 50, height: 60 }, pad: { left: 50, top: 60, right: 50, bottom: 60 } });
    expect(ctx.clip).not.toHaveBeenCalled();
    // Layer = 150 × 180 composition px at pixelRatio 2, placed at (100 − 50, 200 − 60).
    expect(ctx.drawImage).toHaveBeenCalledWith(bmp, 0, 0, 300, 360, 50, 140, 150, 180);
  });
  // Review N1: the preview answers with the newest bitmap it HAS, which may
  // have been rendered for another box or pixel ratio. The draw maps the
  // bitmap's own geometry onto the current box instead of cutting the current
  // request's source rect out of it.
  it("a held bitmap rendered at pixel ratio 2, drawn for a request at 1.5, fills the box — no zoom, no crop (review N1)", () => {
    const overlay = { id: "c", kind: "code", startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 10, y: 20, width: 300, height: 150 }, drawFunction: "" } as unknown as Overlay;
    const bmp = fakeBitmap(600, 300);
    const layers = fakeLayers({ c: bmp }, { renderedFor: { c: { size: { width: 300, height: 150 }, pixelRatio: 2 } } });
    const ctx = mockCtx();
    drawOverlay(overlay, { ...base(ctx, layers), renderScale: 1.5 });
    expect(layers.requests[0].pixelRatio).toBe(1.5);
    // The whole 2× bitmap, onto the whole box.
    expect(ctx.drawImage).toHaveBeenCalledWith(bmp, 0, 0, 600, 300, 10, 20, 300, 150);
  });
  it("a held tracked bitmap rendered for a smaller box lands on the current box, pad included (review N1)", () => {
    const track: Track = {
      id: "trk", fileId: "f", method: "mediapipe-face", framerate: 30, durationSec: 2,
      samples: [
        { t: 0, x: 100, y: 200, w: 50, h: 60, confidence: 0.9, visible: true },
        { t: 2, x: 100, y: 200, w: 50, h: 60, confidence: 0.9, visible: true },
      ],
    };
    const overlay = {
      id: "k", kind: "tracked", trackId: "trk", startTime: 0, duration: 2, z: 0, opacity: 1,
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, fit: "tight", scale: 1, smoothing: "linear",
      content: { kind: "code", drawFunction: "" },
    } as unknown as Overlay;
    const bmp = fakeBitmap(120, 180);
    // Rendered a frame earlier for a 25 × 30 box whose pad was cut back on the
    // left (as at a canvas edge): layer = (10 + 25 + 25) × (30 + 30 + 30).
    const layers = fakeLayers({ k: bmp }, {
      renderedFor: { k: { size: { width: 25, height: 30 }, pad: { left: 10, top: 30, right: 25, bottom: 30 }, pixelRatio: 2 } },
    });
    const ctx = mockCtx();
    drawOverlay(overlay, { ...base(ctx, layers), tracks: { trk: track } });
    expect(layers.requests[0]).toMatchObject({ size: { width: 50, height: 60 }, pad: { left: 50, top: 60, right: 50, bottom: 60 } });
    // Scale 50/25 = 2 and 60/30 = 2: the old box (10, 30) inside the layer
    // lands on the current box (100, 200), and its pad scales with it.
    expect(ctx.drawImage).toHaveBeenCalledWith(bmp, 0, 0, 120, 180, 100 - 10 * 2, 200 - 30 * 2, 60 * 2, 90 * 2);
    expect(ctx.clip).not.toHaveBeenCalled();
  });
  it("a bitmap rendered for exactly the current geometry still draws 1:1 (review N1)", () => {
    const overlay = { id: "c", kind: "code", startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 10.25, y: 20.5, width: 101, height: 51 }, drawFunction: "" } as unknown as Overlay;
    // The runtime's canvas is ceil(101 × 1.5) × ceil(51 × 1.5) = 152 × 77.
    const bmp = fakeBitmap(152, 77);
    const layers = fakeLayers({ c: bmp }, { renderedFor: { c: { size: { width: 101, height: 51 }, pixelRatio: 1.5 } } });
    const ctx = mockCtx();
    drawOverlay(overlay, { ...base(ctx, layers), renderScale: 1.5 });
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    // Source = the box's device px, not the whole ceil'd bitmap: nothing is
    // squeezed, so the layer is not resampled every frame.
    expect(ctx.drawImage).toHaveBeenCalledWith(bmp, 0, 0, 151.5, 76.5, 10.25, 20.5, 101, 51);
  });
  it("without a LayerSource a body overlay is a no-op (transient loading)", () => {
    const overlay = { id: "c", kind: "code", startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, drawFunction: "" } as unknown as Overlay;
    const ctx = mockCtx();
    expect(() => drawOverlay(overlay, base(ctx, undefined))).not.toThrow();
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });
});
