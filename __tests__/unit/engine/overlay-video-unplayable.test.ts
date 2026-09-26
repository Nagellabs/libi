/**
 * T3 (2026-09-25): a video overlay whose source has FAILED draws a quiet
 * in-canvas placeholder on its own rect — "This video can't be played" plus the
 * file's name — instead of a frozen/black frame under an endless "Buffering…".
 */
import { describe, it, expect, vi } from "vitest";
import { drawOverlayContent2D } from "@/lib/engine/overlay-renderer";
import type { VideoFrameSource, VideoFrameSourceFailure } from "@/lib/engine/video-frame-source";

function recCtx() {
  const drawn: unknown[] = [];
  const texts: string[] = [];
  const fills: Array<[number, number, number, number]> = [];
  const obj = {
    drawn, texts, fills,
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, rect() {}, clip() {}, setLineDash() {}, strokeRect() {},
    drawImage(img: unknown) { drawn.push(img); },
    clearRect() {},
    fillText(t: string) { texts.push(t); },
    fillRect(x: number, y: number, w: number, h: number) { fills.push([x, y, w, h]); },
    strokeText() {},
    measureText(s: string) { return { width: s.length * 6 }; },
    globalAlpha: 1, filter: "none", fillStyle: "#000",
    textAlign: "left" as CanvasTextAlign, textBaseline: "alphabetic" as CanvasTextBaseline,
    font: "10px sans-serif", shadowColor: "transparent", shadowBlur: 0,
    shadowOffsetX: 0, shadowOffsetY: 0, strokeStyle: "#000", lineWidth: 1,
    imageSmoothingEnabled: true,
  };
  return obj as unknown as CanvasRenderingContext2D & {
    drawn: unknown[]; texts: string[]; fills: Array<[number, number, number, number]>;
  };
}

function source(failure: VideoFrameSourceFailure | null) {
  const getFrame = vi.fn(() => Object.assign({ tag: "live" }, { width: 10, height: 10 }) as unknown as CanvasImageSource);
  const seek = vi.fn();
  const src: VideoFrameSource = {
    getFrame, seek, play: () => {}, pause: () => {}, dispose: () => {},
    isReadyAt: () => true,
    failure: () => failure,
  };
  return { src, getFrame, seek };
}

const RECT = { x: 40, y: 60, width: 720, height: 1280 };

function overlay(extra: Record<string, unknown> = {}) {
  return {
    id: "v1", kind: "video", fileId: "f1", startTime: 0, duration: 5, z: 0,
    opacity: 1, rect: RECT, fit: "cover", ...extra,
  } as never;
}

function draw(o: never, src: VideoFrameSource) {
  const ctx = recCtx();
  drawOverlayContent2D(
    o,
    { ctx, time: 1, fps: 30, width: 1080, height: 1920, videoFrameSources: { v1: src } } as never,
    RECT,
  );
  return ctx;
}

describe("video overlay — unplayable source placeholder", () => {
  it("draws the placeholder on the overlay's rect, naming the file, and never asks the source for a frame", () => {
    const { src, getFrame, seek } = source({ kind: "permanent", message: "400 Bad Request" });
    const ctx = draw(overlay({ sourceName: "Morning vibe happyhippie" }), src);
    expect(ctx.texts).toContain("This video can't be played");
    expect(ctx.texts).toContain("Morning vibe happyhippie");
    expect(ctx.fills[0]).toEqual([RECT.x, RECT.y, RECT.width, RECT.height]);
    expect(ctx.drawn).toHaveLength(0);
    expect(getFrame).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
  });

  it("prefers the overlay's display name over the file name", () => {
    const { src } = source({ kind: "permanent", message: "x" });
    const ctx = draw(overlay({ displayName: "Opening clip", sourceName: "file.mp4" }), src);
    expect(ctx.texts).toContain("Opening clip");
    expect(ctx.texts).not.toContain("file.mp4");
  });

  it("shows the headline alone when there is no name", () => {
    const { src } = source({ kind: "transient", message: "503" });
    const ctx = draw(overlay(), src);
    expect(ctx.texts).toEqual(["This video can't be played"]);
  });

  it("shortens a long name to fit the rect", () => {
    const { src } = source({ kind: "permanent", message: "x" });
    const long = "Morning_vibe_".repeat(40);
    const ctx = draw(overlay({ sourceName: long }), src);
    const label = ctx.texts.find((t) => t !== "This video can't be played")!;
    expect(label.endsWith("…")).toBe(true);
    expect(label.length * 6).toBeLessThanOrEqual(RECT.width);
  });

  it("a healthy source still paints its frame (unchanged)", () => {
    const { src } = source(null);
    const ctx = draw(overlay({ sourceName: "x" }), src);
    expect(ctx.drawn).toHaveLength(1);
    expect(ctx.texts).toHaveLength(0);
  });
});
