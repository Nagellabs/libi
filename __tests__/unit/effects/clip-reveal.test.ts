import { describe, it, expect } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { TextOverlay } from "@/lib/engine/types";

describe("clipReveal renderer support", () => {
  it("an overlay with no clipReveal calls clip() zero times (no-op path intact)", () => {
    let clips = 0;
    const overlay: TextOverlay = {
      id: "p", kind: "text", startTime: 0, duration: 2, z: 0,
      rect: { x: 10, y: 10, width: 100, height: 50 }, opacity: 1,
      content: "Aa", font: "24px Inter", color: "#fff", align: "left",
    };
    const ctx = {
      save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
      beginPath() {}, rect() {}, clip() { clips++; }, fill() {}, stroke() {}, fillText() {},
      measureText() { return { width: 10 } as TextMetrics; }, fillRect() {},
      set globalAlpha(_v: number) {}, get globalAlpha() { return 1; },
      set filter(_v: string) {}, get filter() { return "none"; },
      set font(_v: string) {}, get font() { return "10px sans"; },
      set fillStyle(_v: string) {}, get fillStyle() { return "#000"; },
      set textAlign(_v: string) {}, get textAlign() { return "left" as CanvasTextAlign; },
      set textBaseline(_v: string) {}, get textBaseline() { return "alphabetic" as CanvasTextBaseline; },
    } as unknown as CanvasRenderingContext2D;
    drawOverlay(overlay, { ctx, width: 200, height: 100, fps: 30, totalFrames: 60, frame: 0, time: 0, assets: {} } as DrawOverlayContext);
    expect(clips).toBe(0);
  });
});
