// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay, TextOverlay } from "@/lib/engine/types";

/** Mock 2D context that records the ordered call log plus mutable style props
 *  (font / shadow / stroke). Mirrors the style of tracked-overlay-render.test. */
function makeMockCtx() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const ctx = {
    save: vi.fn(() => calls.push({ fn: "save", args: [] })),
    restore: vi.fn(() => calls.push({ fn: "restore", args: [] })),
    translate: vi.fn((...args: unknown[]) => calls.push({ fn: "translate", args })),
    scale: vi.fn((...args: unknown[]) => calls.push({ fn: "scale", args })),
    fillText: vi.fn((...args: unknown[]) => calls.push({ fn: "fillText", args })),
    strokeText: vi.fn((...args: unknown[]) => calls.push({ fn: "strokeText", args })),
    fillRect: vi.fn((...args: unknown[]) => calls.push({ fn: "fillRect", args })),
    beginPath: vi.fn(() => calls.push({ fn: "beginPath", args: [] })),
    rect: vi.fn((...args: unknown[]) => calls.push({ fn: "rect", args })),
    roundRect: vi.fn((...args: unknown[]) => calls.push({ fn: "roundRect", args })),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arcTo: vi.fn((...args: unknown[]) => calls.push({ fn: "arcTo", args })),
    closePath: vi.fn(),
    fill: vi.fn((...args: unknown[]) => calls.push({ fn: "fill", args })),
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
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const baseText: TextOverlay = {
  id: "tx",
  kind: "text",
  startTime: 0,
  duration: 2,
  rect: { x: 100, y: 200, width: 400, height: 120 },
  z: 10,
  opacity: 1,
  content: "Hello",
  font: "48px Inter",
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

describe("text overlay render — baseline (no new fields)", () => {
  it("draws a single styled fillText with composed font, color, align", () => {
    const { ctx, calls } = ctxFor(baseText);
    const fills = calls.filter((c) => c.fn === "fillText");
    expect(fills).toHaveLength(1);
    expect(fills[0].args[0]).toBe("Hello");
    expect(ctx.font).toBe("48px Inter");
    expect(ctx.fillStyle).toBe("#ffffff");
    expect(ctx.textAlign).toBe("left");
    // No background plate, no stroke when fields absent.
    expect(calls.find((c) => c.fn === "fillRect")).toBeUndefined();
    expect(calls.find((c) => c.fn === "strokeText")).toBeUndefined();
  });

  it("structured font fields compose into ctx.font", () => {
    const { ctx } = ctxFor({ ...baseText, fontFamily: "Roboto", fontSize: 64, fontWeight: 700 });
    expect(ctx.font).toBe("700 64px Roboto");
  });

  it("center align places x at rect center", () => {
    const { calls } = ctxFor({ ...baseText, align: "center" });
    const fill = calls.find((c) => c.fn === "fillText")!;
    expect(fill.args[1]).toBe(100 + 400 / 2);
  });
});

describe("text overlay render — background plate", () => {
  it("fills a plate BEFORE the text, sized to measured text + padding", () => {
    const { calls } = ctxFor({
      ...baseText,
      background: { color: "#000000", padding: 8, radius: 0 },
    });
    const plateIdx = calls.findIndex((c) => c.fn === "fillRect");
    const textIdx = calls.findIndex((c) => c.fn === "fillText");
    expect(plateIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(plateIdx);
    // "Hello" measured at 5*10=50 wide; + 2*padding(8) = 66 minimum.
    const [, , w] = calls[plateIdx].args as number[];
    expect(w).toBeGreaterThanOrEqual(50 + 16);
  });

  it("uses roundRect when radius > 0", () => {
    const { calls } = ctxFor({
      ...baseText,
      background: { color: "#000000", padding: 8, radius: 12 },
    });
    const usedRounded =
      calls.some((c) => c.fn === "roundRect") || calls.some((c) => c.fn === "arcTo");
    expect(usedRounded).toBe(true);
  });
});

describe("text overlay render — stroke", () => {
  it("calls strokeText then fillText with stroke color/width applied", () => {
    const { ctx, calls } = ctxFor({
      ...baseText,
      stroke: { color: "#ff0000", width: 4 },
    });
    const strokeIdx = calls.findIndex((c) => c.fn === "strokeText");
    const fillIdx = calls.findIndex((c) => c.fn === "fillText");
    expect(strokeIdx).toBeGreaterThanOrEqual(0);
    expect(fillIdx).toBeGreaterThan(strokeIdx);
    expect(ctx.strokeStyle).toBe("#ff0000");
    expect(ctx.lineWidth).toBe(4);
  });
});

describe("text overlay render — shadow", () => {
  it("sets shadowColor/shadowBlur before drawing and resets after", () => {
    let blurAtFill = 0;
    let colorAtFill = "transparent";
    const { ctx, calls } = makeMockCtx();
    const origFill = ctx.fillText as unknown as (...a: unknown[]) => void;
    (ctx as unknown as { fillText: (...a: unknown[]) => void }).fillText = (...a: unknown[]) => {
      blurAtFill = ctx.shadowBlur;
      colorAtFill = ctx.shadowColor;
      origFill(...a);
    };
    drawOverlay(
      { ...baseText, shadow: { color: "#000000", blur: 10, dx: 2, dy: 3 } } as Overlay,
      {
        ctx,
        width: 1920,
        height: 1080,
        fps: 30,
        totalFrames: 60,
        frame: 30,
        time: 1,
        assets: {},
      } as DrawOverlayContext,
    );
    expect(blurAtFill).toBe(10);
    expect(colorAtFill).toBe("#000000");
    // Reset afterwards.
    expect(ctx.shadowBlur).toBe(0);
    expect(ctx.shadowColor === "transparent" || ctx.shadowColor === "rgba(0,0,0,0)").toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("text overlay render — word wrap", () => {
  it("long content wraps into multiple fillText calls when maxWidthPct is set", () => {
    // Point-text wraps to maxWidthPct * frameWidth, NOT rect.width.
    // measureText returns len*10; frame 1920 × 0.21 ≈ 403px ⇒ ~40 chars/line.
    const long = "word ".repeat(30).trim(); // 30 words
    const { calls } = ctxFor({ ...baseText, content: long, maxWidthPct: 0.21 });
    const fills = calls.filter((c) => c.fn === "fillText");
    expect(fills.length).toBeGreaterThan(1);
  });

  it("long content WITHOUT maxWidthPct stays a single line (no reflow-to-rect)", () => {
    const long = "word ".repeat(30).trim();
    const { calls } = ctxFor({ ...baseText, content: long });
    const fills = calls.filter((c) => c.fn === "fillText");
    expect(fills.length).toBe(1);
    expect(String(fills[0].args[0])).toBe(long);
  });
});

describe("text overlay render — reveal typewriter", () => {
  it("truncates the drawn string at small element-local progress", () => {
    // duration 2s, fraction default 0.6 ⇒ full at t=1.2s. At t=0.3 (progress 0.15),
    // local = 0.15/0.6 = 0.25 ⇒ ~1-2 chars of "Hello world".
    const overlay: TextOverlay = {
      ...baseText,
      content: "Hello world",
      reveal: { mode: "typewriter" },
    };
    const { calls } = ctxFor(overlay, 0.3);
    const fills = calls.filter((c) => c.fn === "fillText");
    expect(fills.length).toBeGreaterThanOrEqual(1);
    const drawn = fills.map((c) => String(c.args[0])).join("");
    expect(drawn.length).toBeLessThan("Hello world".length);
  });

  it("reveal mode none behaves like baseline (full text)", () => {
    const { calls } = ctxFor({ ...baseText, content: "Hi", reveal: { mode: "none" } }, 0.1);
    const fills = calls.filter((c) => c.fn === "fillText");
    expect(fills).toHaveLength(1);
    expect(fills[0].args[0]).toBe("Hi");
  });
});
