import { describe, it, expect } from "vitest";
import { drawOverlayContent2D } from "@/lib/engine/overlay-renderer";
import type { VideoFrameSource } from "@/lib/engine/video-frame-source";

/** A ctx that records the actual image source passed to drawImage, so we can
 *  assert WHICH frame (live vs held) was painted. */
function recCtx() {
  const drawn: unknown[] = [];
  const obj = {
    drawn,
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, rect() {}, clip() {},
    drawImage(img: unknown) { drawn.push(img); },
    clearRect() {}, fillText() {}, fillRect() {}, strokeText() {},
    measureText() { return { width: 10 }; },
    globalAlpha: 1, filter: "none", fillStyle: "#000",
    textAlign: "left" as CanvasTextAlign, textBaseline: "alphabetic" as CanvasTextBaseline,
    font: "10px sans-serif", shadowColor: "transparent", shadowBlur: 0,
    shadowOffsetX: 0, shadowOffsetY: 0, strokeStyle: "#000", lineWidth: 1,
    imageSmoothingEnabled: true,
  };
  return obj as unknown as CanvasRenderingContext2D & { drawn: unknown[] };
}

function videoOverlay() {
  return {
    id: "v1", kind: "video", fileId: "f1", startTime: 0, duration: 5, z: 0,
    opacity: 1, rect: { x: 0, y: 0, width: 100, height: 100 }, fit: "cover",
  } as never;
}

/** A fake source: `getFrame` returns `live`, `lastGoodFrame` returns `held`. */
function fakeSource(opts: {
  ready: boolean;
  live: unknown;
  held: unknown;
}): VideoFrameSource {
  const dims = (c: unknown) => Object.assign(c as object, { width: 100, height: 100 });
  return {
    getFrame: () => dims(opts.live) as CanvasImageSource,
    seek: () => {},
    play: () => {},
    pause: () => {},
    isReadyAt: () => opts.ready,
    lastGoodFrame: () => (opts.held ? (dims(opts.held) as CanvasImageSource) : null),
    dispose: () => {},
  };
}

describe("video overlay hold-last-frame fallback (drawOverlayContent2D)", () => {
  it("paints the HELD last-good frame when the source is NOT ready", () => {
    const live = { tag: "live" };
    const held = { tag: "held" };
    const ctx = recCtx();
    const src = fakeSource({ ready: false, live, held });
    drawOverlayContent2D(
      videoOverlay(),
      { ctx, time: 0, fps: 30, width: 100, height: 100, videoFrameSources: { v1: src } } as never,
      { x: 0, y: 0, width: 100, height: 100 },
    );
    expect(ctx.drawn).toHaveLength(1);
    expect((ctx.drawn[0] as { tag: string }).tag).toBe("held");
  });

  it("paints the LIVE frame when the source IS ready (unchanged behavior)", () => {
    const live = { tag: "live" };
    const held = { tag: "held" };
    const ctx = recCtx();
    const src = fakeSource({ ready: true, live, held });
    drawOverlayContent2D(
      videoOverlay(),
      { ctx, time: 0, fps: 30, width: 100, height: 100, videoFrameSources: { v1: src } } as never,
      { x: 0, y: 0, width: 100, height: 100 },
    );
    expect((ctx.drawn[0] as { tag: string }).tag).toBe("live");
  });

  it("falls back to the LIVE frame when not-ready but no held frame exists", () => {
    const live = { tag: "live" };
    const ctx = recCtx();
    const src = fakeSource({ ready: false, live, held: null });
    drawOverlayContent2D(
      videoOverlay(),
      { ctx, time: 0, fps: 30, width: 100, height: 100, videoFrameSources: { v1: src } } as never,
      { x: 0, y: 0, width: 100, height: 100 },
    );
    expect((ctx.drawn[0] as { tag: string }).tag).toBe("live");
  });
});
