// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay } from "@/lib/engine/types";
import type { Track } from "@/lib/tracking/types";

function makeMockCtx() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const ctx = {
    save: vi.fn(), restore: vi.fn(),
    translate: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
    fillText: vi.fn((...args: unknown[]) => calls.push({ fn: "fillText", args })),
    drawImage: vi.fn(), fillRect: vi.fn(),
    set globalAlpha(_v: number) {}, get globalAlpha() { return 1; },
    font: "", textAlign: "left" as CanvasTextAlign, textBaseline: "alphabetic" as CanvasTextBaseline,
    fillStyle: "#000" as string,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

// x encodes clip time: t=0->x=0, t=20->x=2000.
const track: Track = {
  id: "t", fileId: "f", method: "yoloe+botsort", framerate: 30, durationSec: 20,
  samples: [
    { t: 0, x: 0, y: 100, w: 40, h: 40, confidence: 0.9, visible: true },
    { t: 20, x: 2000, y: 100, w: 40, h: 40, confidence: 0.9, visible: true },
  ],
};
const ctxArgs = {
  width: 1920, height: 1080, fps: 30, totalFrames: 600, frame: 450,
  time: 15, assets: {}, tracks: { t: track },
} as const;

describe("tracked overlay samples at absolute clip time", () => {
  it("a late-starting overlay on a shared track draws at the SAME place as a full-clip overlay", () => {
    const common = {
      kind: "tracked" as const, trackId: "t",
      content: { kind: "emoji" as const, char: "😀" },
      fit: "tight" as const, scale: 1, smoothing: "linear" as const,
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 10, opacity: 1,
    };
    const full: Overlay = { ...common, id: "a", startTime: 0, duration: 20 };
    const late: Overlay = { ...common, id: "b", startTime: 10, duration: 10 };

    const a = makeMockCtx();
    drawOverlay(full, { ...ctxArgs, ctx: a.ctx } as DrawOverlayContext);
    const b = makeMockCtx();
    drawOverlay(late, { ...ctxArgs, ctx: b.ctx } as DrawOverlayContext);

    const ax = (a.calls.find((c) => c.fn === "fillText")!.args[1]) as number;
    const bx = (b.calls.find((c) => c.fn === "fillText")!.args[1]) as number;
    // Both evaluated at wall-clock t=15 -> both must sample clip time 15.
    expect(bx).toBeCloseTo(ax, 5);
  });
});
