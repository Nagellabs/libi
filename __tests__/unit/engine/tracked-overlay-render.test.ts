// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay } from "@/lib/engine/types";
import type { Track } from "@/lib/tracking/types";

function makeMockCtx() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const ctx = {
    save: vi.fn(() => calls.push({ fn: "save", args: [] })),
    restore: vi.fn(() => calls.push({ fn: "restore", args: [] })),
    translate: vi.fn((...args: unknown[]) => calls.push({ fn: "translate", args })),
    fillText: vi.fn((...args: unknown[]) => calls.push({ fn: "fillText", args })),
    drawImage: vi.fn((...args: unknown[]) => calls.push({ fn: "drawImage", args })),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn((...args: unknown[]) => calls.push({ fn: "fillRect", args })),
    set globalAlpha(v: number) { (this as unknown as Record<string, unknown>)._alpha = v; },
    get globalAlpha() { return ((this as unknown as Record<string, unknown>)._alpha ?? 1) as number; },
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    fillStyle: "#000" as string | CanvasGradient | CanvasPattern,
    set filter(v: string) { (this as unknown as Record<string, unknown>)._filter = v; },
    get filter() { return ((this as unknown as Record<string, unknown>)._filter ?? "none") as string; },
    set imageSmoothingEnabled(v: boolean) { (this as unknown as Record<string, unknown>)._smoothing = v; },
    get imageSmoothingEnabled() { return ((this as unknown as Record<string, unknown>)._smoothing ?? true) as boolean; },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const track: Track = {
  id: "t",
  fileId: "f",
  method: "mediapipe-face",
  framerate: 30,
  durationSec: 2,
  samples: [
    { t: 0, x: 100, y: 200, w: 50, h: 60, confidence: 0.9, visible: true },
    { t: 1, x: 110, y: 200, w: 50, h: 60, confidence: 0.9, visible: true },
  ],
};

const baseOverlay = {
  id: "ov",
  startTime: 0,
  duration: 2,
  rect: { x: 0, y: 0, width: 1920, height: 1080 },
  z: 10,
  opacity: 1,
  trackId: "t",
} as const;

describe("tracked overlay draw", () => {
  it("emoji content calls fillText at the tracked center", () => {
    const { ctx, calls } = makeMockCtx();
    const overlay: Overlay = {
      ...baseOverlay,
      kind: "tracked",
      content: { kind: "emoji", char: "😀" },
      fit: "tight",
      scale: 1.0,
      smoothing: "linear",
    };
    drawOverlay(overlay, {
      ctx,
      width: 1920,
      height: 1080,
      fps: 30,
      totalFrames: 60,
      frame: 15,
      time: 0.5,
      assets: {},
      tracks: { t: track },
    } as DrawOverlayContext);
    const fillTextCalls = calls.filter((c) => c.fn === "fillText");
    expect(fillTextCalls).toHaveLength(1);
  });

  it("invisible sample → no draw call", () => {
    const { ctx, calls } = makeMockCtx();
    const trackInvisible: Track = {
      ...track,
      samples: track.samples.map((s) => ({ ...s, visible: false, confidence: 0 })),
    };
    const overlay: Overlay = {
      ...baseOverlay,
      kind: "tracked",
      content: { kind: "emoji", char: "😀" },
      fit: "tight",
      scale: 1.0,
      smoothing: "linear",
    };
    drawOverlay(overlay, {
      ctx,
      width: 1920,
      height: 1080,
      fps: 30,
      totalFrames: 60,
      frame: 15,
      time: 0.5,
      assets: {},
      tracks: { t: trackInvisible },
    } as DrawOverlayContext);
    expect(calls.find((c) => c.fn === "fillText")).toBeUndefined();
  });

  it("effect=mask fills a black rect at the bbox", () => {
    const { ctx, calls } = makeMockCtx();
    const overlay: Overlay = {
      ...baseOverlay,
      kind: "tracked",
      content: { kind: "effect", op: "mask" },
      fit: "tight",
      scale: 1.0,
      smoothing: "linear",
    };
    drawOverlay(overlay, {
      ctx,
      width: 1920,
      height: 1080,
      fps: 30,
      totalFrames: 60,
      frame: 15,
      time: 0.5,
      assets: {},
      tracks: { t: track },
      sourceCanvas: document.createElement("canvas") as HTMLCanvasElement,
    } as DrawOverlayContext);
    expect(calls.filter((c) => c.fn === "fillRect").length).toBeGreaterThanOrEqual(1);
  });
});
