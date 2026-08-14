// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay, TextOverlay } from "@/lib/engine/types";

/** Mock 2D context that records each fillText with the fillStyle live at the
 *  moment of the call. Mirrors the style of overlay-renderer-text.test. */
function makeMockCtx() {
  const fills: { text: string; x: number; fillStyle: string }[] = [];
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    fillText: vi.fn((text: string, x: number) =>
      fills.push({ text, x, fillStyle: ctx.fillStyle as string }),
    ),
    strokeText: vi.fn(),
    fillRect: vi.fn(),
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
    set globalAlpha(v: number) { (this as unknown as Record<string, unknown>)._alpha = v; },
    get globalAlpha() { return ((this as unknown as Record<string, unknown>)._alpha ?? 1) as number; },
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    fillStyle: "#000" as string | CanvasGradient | CanvasPattern,
    strokeStyle: "#000" as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    set shadowColor(v: string) { (this as unknown as Record<string, unknown>)._shadowColor = v; },
    get shadowColor() { return ((this as unknown as Record<string, unknown>)._shadowColor ?? "transparent") as string; },
    set shadowBlur(v: number) { (this as unknown as Record<string, unknown>)._shadowBlur = v; },
    get shadowBlur() { return ((this as unknown as Record<string, unknown>)._shadowBlur ?? 0) as number; },
    set shadowOffsetX(v: number) { (this as unknown as Record<string, unknown>)._shadowOffsetX = v; },
    get shadowOffsetX() { return ((this as unknown as Record<string, unknown>)._shadowOffsetX ?? 0) as number; },
    set shadowOffsetY(v: number) { (this as unknown as Record<string, unknown>)._shadowOffsetY = v; },
    get shadowOffsetY() { return ((this as unknown as Record<string, unknown>)._shadowOffsetY ?? 0) as number; },
  } as unknown as CanvasRenderingContext2D & { fillStyle: string };
  return { ctx, fills };
}

const baseText: TextOverlay = {
  id: "tx",
  kind: "text",
  startTime: 0,
  duration: 2,
  rect: { x: 100, y: 200, width: 400, height: 120 },
  z: 10,
  opacity: 1,
  content: "a b c",
  font: "48px Inter",
  color: "#ffffff",
  align: "left",
};

function drawAt(overlay: Overlay, time: number) {
  const { ctx, fills } = makeMockCtx();
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
  return { ctx, fills };
}

describe("text overlay reveal — word-current", () => {
  it("draws ONLY the active word at progress 0.5", () => {
    // duration 2, time 1 ⇒ progress 0.5 ⇒ word index 1 ⇒ "b".
    const { fills } = drawAt({ ...baseText, reveal: { mode: "word-current" } }, 1);
    const texts = fills.map((f) => f.text);
    expect(texts).toEqual(["b"]);
  });
});

describe("text overlay reveal — karaoke", () => {
  it("draws the full line and re-fills the active word in the default highlight", () => {
    // duration 2, time 1 ⇒ progress 0.5 ⇒ active word index 1 ⇒ "b".
    const { fills } = drawAt({ ...baseText, reveal: { mode: "karaoke" } }, 1);
    // The full line text is drawn at least once.
    expect(fills.some((f) => f.text === "a b c")).toBe(true);
    // The active word "b" is filled in the default highlight (#ffd400) somewhere.
    const highlighted = fills.filter((f) => f.fillStyle.toLowerCase() === "#ffd400");
    expect(highlighted.length).toBeGreaterThanOrEqual(1);
    expect(highlighted.some((f) => f.text === "b")).toBe(true);
  });

  it("honors an explicit highlightColor", () => {
    const { fills } = drawAt(
      { ...baseText, reveal: { mode: "karaoke", highlightColor: "#00ff00" } },
      1,
    );
    const highlighted = fills.filter((f) => f.fillStyle.toLowerCase() === "#00ff00");
    expect(highlighted.some((f) => f.text === "b")).toBe(true);
  });
});
