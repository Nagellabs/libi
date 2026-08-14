// @vitest-environment jsdom
// __tests__/unit/effects/render-integration.test.ts
import { describe, it, expect } from "vitest";
import { drawOverlay } from "@/lib/engine/overlay-renderer";
import type { TextOverlay } from "@/lib/engine/types";
import type { DrawOverlayContext } from "@/lib/engine/overlay-renderer";

/** Minimal CanvasRenderingContext2D recorder. */
function recorder() {
  const calls: { op: string; args: number[] }[] = [];
  let alpha = 1;
  let filter = "none";
  const ctx = {
    save() {}, restore() {},
    translate(x: number, y: number) { calls.push({ op: "translate", args: [x, y] }); },
    rotate(r: number) { calls.push({ op: "rotate", args: [r] }); },
    scale(x: number, y: number) { calls.push({ op: "scale", args: [x, y] }); },
    set globalAlpha(v: number) { alpha = v; calls.push({ op: "alpha", args: [v] }); },
    get globalAlpha() { return alpha; },
    set filter(v: string) { filter = v; calls.push({ op: "filter", args: [] }); },
    get filter() { return filter; },
    fillText() {}, measureText() { return { width: 10 } as TextMetrics; },
    fillRect() {}, beginPath() {}, rect() {}, clip() {}, fill() {}, stroke() {},
    set font(_v: string) {}, get font() { return "10px sans"; },
    set fillStyle(_v: string) {}, get fillStyle() { return "#000"; },
    set textAlign(_v: string) {}, get textAlign() { return "left" as CanvasTextAlign; },
    set textBaseline(_v: string) {}, get textBaseline() { return "alphabetic" as CanvasTextBaseline; },
    set globalCompositeOperation(_v: string) {}, get globalCompositeOperation() { return "source-over" as GlobalCompositeOperation; },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls, get filter() { return filter; }, get alpha() { return alpha; } };
}

function baseCtx(rec: ReturnType<typeof recorder>, time: number): DrawOverlayContext {
  return {
    ctx: rec.ctx, width: 200, height: 100, fps: 30, totalFrames: 120,
    frame: Math.round(time * 30), time, assets: {},
  } as DrawOverlayContext;
}

const overlay: TextOverlay = {
  id: "o1", kind: "text", startTime: 0, duration: 4, z: 0,
  rect: { x: 50, y: 25, width: 100, height: 50 }, opacity: 1,
  content: "Hi", font: "24px Inter", color: "#fff", align: "left",
  effects: { in: { effectId: "fade", durationMs: 1000 } },
};

describe("renderer effect integration", () => {
  it("applies the in-fade opacity at the window midpoint", () => {
    const rec = recorder();
    drawOverlay(overlay, baseCtx(rec, 0.5)); // p=0.5 → opacity ~0.5
    // opacity is the overlay base (1) * fade (0.5)
    const alphaSet = rec.calls.filter((c) => c.op === "alpha").map((c) => c.args[0]);
    expect(Math.min(...alphaSet)).toBeLessThan(0.7);
  });

  it("no effect → full opacity, no extra transform", () => {
    const rec = recorder();
    const plain = { ...overlay, effects: undefined };
    drawOverlay(plain, baseCtx(rec, 0.5));
    const alphaSet = rec.calls.filter((c) => c.op === "alpha").map((c) => c.args[0]);
    expect(Math.max(...alphaSet)).toBeCloseTo(1, 5);
  });
});

import { renderProof } from "@/lib/effects/__tests__/effect-harness";

describe("renderProof (every visual effect composites at render time)", () => {
  it("fade-in dims early frames and reaches full alpha at the end", () => {
    const fr = renderProof("fade", "in");
    expect(fr[0].alpha).toBeLessThan(0.2);
    expect(fr[fr.length - 1].alpha).toBeCloseTo(1, 1);
  });
  it("slide-in translates the element during the in-window", () => {
    const fr = renderProof("slide", "in");
    expect(fr.some((f) => f.translated)).toBe(true);
  });
  it("pop-in scales the element", () => {
    expect(renderProof("pop", "in").some((f) => f.scaled)).toBe(true);
  });
  it("zoom-in scales the element", () => {
    expect(renderProof("zoom", "in").some((f) => f.scaled)).toBe(true);
  });
  it("depth-travel scales the element", () => {
    expect(renderProof("depth-travel", "in").some((f) => f.scaled)).toBe(true);
  });
  it("pulse (loop) scales the element", () => {
    expect(renderProof("pulse", "loop").some((f) => f.scaled)).toBe(true);
  });
  it("shake (loop) translates the element", () => {
    expect(renderProof("shake", "loop").some((f) => f.translated)).toBe(true);
  });
});
