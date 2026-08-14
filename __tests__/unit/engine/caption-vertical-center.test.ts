// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay, TextOverlay } from "@/lib/engine/types";

/** Recording 2D context: logs fillText (with x,y) + the props the renderer reads
 *  back (measureText → len*10 so wrapping is deterministic). */
function makeMockCtx() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    fillText: vi.fn((...args: unknown[]) => calls.push({ fn: "fillText", args })),
    strokeText: vi.fn((...args: unknown[]) => calls.push({ fn: "strokeText", args })),
    fillRect: vi.fn((...args: unknown[]) => calls.push({ fn: "fillRect", args })),
    beginPath: vi.fn(),
    rect: vi.fn(),
    roundRect: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn(),
    measureText: vi.fn((s: string) => ({ width: s.length * 10 })),
    set globalAlpha(v: number) { (this as unknown as Record<string, unknown>)._a = v; },
    get globalAlpha() { return ((this as unknown as Record<string, unknown>)._a ?? 1) as number; },
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

// A deliberately TALL rect (height 400) so top-anchored vs centered is far apart.
const tallText: TextOverlay = {
  id: "tx",
  kind: "text",
  startTime: 0,
  duration: 2,
  rect: { x: 100, y: 200, width: 400, height: 400 },
  z: 10,
  opacity: 1,
  content: "Hello",
  font: "48px Inter",
  fontSize: 48,
  color: "#ffffff",
  align: "left",
};

function ctxFor(overlay: Overlay, time = 1) {
  const { ctx, calls } = makeMockCtx();
  drawOverlay(overlay, {
    ctx,
    width: 1920,
    height: 1080,
    fps: 30,
    totalFrames: 60,
    frame: Math.round(time * 30),
    time,
    assets: {},
  } as DrawOverlayContext);
  return { ctx, calls };
}

describe("caption vertical centering", () => {
  it("single line is centered in a tall rect, not top-anchored", () => {
    const { calls } = ctxFor(tallText);
    const fills = calls.filter((c) => c.fn === "fillText");
    expect(fills).toHaveLength(1);
    const y = fills[0].args[2] as number;

    const rectTop = 200;
    const rectCenter = 200 + 400 / 2; // 400
    const lineHeight = 48 * 1.2; // 57.6

    // Centered: the line's top baseline (textBaseline "top") sits one line above
    // the vertical center, within a line height.
    expect(Math.abs(y - rectCenter)).toBeLessThan(lineHeight);
    // And it is clearly NOT top-anchored.
    expect(y - rectTop).toBeGreaterThan(lineHeight);
  });

  it("3-line wrapped block centers the MIDDLE line on the rect center", () => {
    // Point-text wraps to maxWidthPct * frameWidth (NOT rect.width).
    // measureText = len*10; frame 1920 × 0.208 ≈ 400px ⇒ ~40 chars/line. Build
    // text that wraps into exactly 3 lines. Vertical centering still uses
    // rect.height (unchanged) — the block centers in the tall rect.
    const word = "wordword"; // 8 chars → 80px; 4 per line ≈ 360px < 400
    const content = Array.from({ length: 12 }, () => word).join(" ");
    const { calls } = ctxFor({ ...tallText, content, maxWidthPct: 0.208 });
    const fills = calls.filter((c) => c.fn === "fillText");
    expect(fills.length).toBeGreaterThanOrEqual(3);

    const ys = fills.map((c) => c.args[2] as number);
    const lineHeight = 48 * 1.2;
    const rectCenter = 200 + 400 / 2; // 400
    // Middle of the drawn block ≈ rect center.
    const blockMid = (ys[0] + ys[ys.length - 1]) / 2 + lineHeight / 2;
    expect(Math.abs(blockMid - rectCenter)).toBeLessThan(lineHeight);
  });
});
