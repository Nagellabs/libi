// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay, TextOverlay } from "@/lib/engine/types";

/** Recording 2D ctx: logs fillText/clip; measureText → len*10. */
function makeMockCtx() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    fillText: vi.fn((...args: unknown[]) => calls.push({ fn: "fillText", args })),
    strokeText: vi.fn((...args: unknown[]) => calls.push({ fn: "strokeText", args })),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    roundRect: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    clip: vi.fn((...args: unknown[]) => calls.push({ fn: "clip", args })),
    drawImage: vi.fn((...args: unknown[]) => calls.push({ fn: "drawImage", args })),
    measureText: vi.fn((s: string) => ({ width: s.length * 10 })),
    set globalAlpha(v: number) { (this as unknown as Record<string, unknown>)._a = v; },
    get globalAlpha() { return ((this as unknown as Record<string, unknown>)._a ?? 1) as number; },
    set filter(v: string) { (this as unknown as Record<string, unknown>)._f = v; },
    get filter() { return ((this as unknown as Record<string, unknown>)._f ?? "none") as string; },
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    fillStyle: "#000" as string | CanvasGradient | CanvasPattern,
    strokeStyle: "#000" as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    shadowColor: "transparent",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

function render(overlay: Overlay, extra?: Partial<DrawOverlayContext>) {
  const { ctx, calls } = makeMockCtx();
  drawOverlay(overlay, {
    ctx,
    width: 1920,
    height: 1080,
    fps: 30,
    totalFrames: 60,
    frame: 0,
    time: 0,
    assets: {},
    ...extra,
  } as DrawOverlayContext);
  return { ctx, calls };
}

function fillStrings(calls: { fn: string; args: unknown[] }[]): string[] {
  return calls.filter((c) => c.fn === "fillText").map((c) => String(c.args[0]));
}

describe("point-text renderer: measured box, no reflow-to-rect, no clip", () => {
  it("(a) long content wider than authored rect.width renders the FULL line (not wrapped to rect) and never clips", () => {
    const longText: TextOverlay = {
      id: "tx",
      kind: "text",
      startTime: 0,
      duration: 2,
      // authored rect is intentionally tiny — old code wrapped to width=50
      rect: { x: 200, y: 200, width: 50, height: 60 },
      z: 10,
      opacity: 1,
      content: "A very long caption line",
      font: "40px Inter",
      fontSize: 40,
      color: "#ffffff",
      align: "center",
      anchor: "mid-center",
      position: { x: 960, y: 540 },
      // no maxWidthPct ⇒ never wrap (single line)
    };
    const { calls } = render(longText);
    const fills = fillStrings(calls);
    // The full, unbroken line must be drawn (not split into many short pieces).
    expect(fills).toContain("A very long caption line");
    // No hard clip applied for a planar text overlay.
    expect(calls.find((c) => c.fn === "clip")).toBeUndefined();
  });

  it("(b) a short single word still renders once with the full word", () => {
    const word: TextOverlay = {
      id: "tx2",
      kind: "text",
      startTime: 0,
      duration: 2,
      rect: { x: 100, y: 100, width: 800, height: 120 },
      z: 10,
      opacity: 1,
      content: "Hi",
      font: "48px Inter",
      fontSize: 48,
      color: "#ffffff",
      align: "left",
      anchor: "mid-center",
      position: { x: 500, y: 500 },
    };
    const { calls } = render(word);
    const fills = fillStrings(calls);
    expect(fills.filter((s) => s === "Hi")).toHaveLength(1);
  });
});
