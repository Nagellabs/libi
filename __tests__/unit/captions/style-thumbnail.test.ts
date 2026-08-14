import { describe, it, expect, vi } from "vitest";
import { renderStyleThumbnail } from "@/lib/captions/style-thumbnail";
import { CAPTION_STYLES } from "@/lib/captions/styles";
import type { CaptionStyle } from "@/lib/captions/types";

// ─── Fake CanvasRenderingContext2D ────────────────────────────────────────────

/**
 * Returns a pair of (ctx, spies) — `ctx` is the fake cast to the real
 * CanvasRenderingContext2D type, `spies` exposes the mock objects with their
 * proper `.mock` accessor so we can make assertions on call counts / args
 * without casting inside each test.
 */
function makeFakeCtx() {
  const fillStyleHistory: Array<string | CanvasGradient | CanvasPattern> = [];
  let _fillStyle: string | CanvasGradient | CanvasPattern = "#000";

  const fillTextSpy = vi.fn<CanvasRenderingContext2D["fillText"]>();
  const strokeTextSpy = vi.fn<CanvasRenderingContext2D["fillText"]>();
  const fillRectSpy = vi.fn<CanvasRenderingContext2D["fillRect"]>();
  const fillSpy = vi.fn<() => void>();
  const measureTextSpy = vi
    .fn<CanvasRenderingContext2D["measureText"]>()
    .mockImplementation((s: string) => {
      return {
        width: s.length * 12,
        actualBoundingBoxAscent: 0,
        actualBoundingBoxDescent: 0,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: 0,
        alphabeticBaseline: 0,
        emHeightAscent: 0,
        emHeightDescent: 0,
        fontBoundingBoxAscent: 0,
        fontBoundingBoxDescent: 0,
        hangingBaseline: 0,
        ideographicBaseline: 0,
      } as TextMetrics;
    });

  const raw = {
    get fillStyle() { return _fillStyle; },
    set fillStyle(v: string | CanvasGradient | CanvasPattern) {
      _fillStyle = v;
      fillStyleHistory.push(v);
    },
    font: "",
    textAlign: "center" as CanvasTextAlign,
    textBaseline: "middle" as CanvasTextBaseline,
    strokeStyle: "#000" as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    shadowColor: "transparent",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,

    fillText: fillTextSpy,
    strokeText: strokeTextSpy,
    fillRect: fillRectSpy,
    measureText: measureTextSpy,

    // Canvas path methods (used for rounded background plates)
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: fillSpy,
    rect: vi.fn(),
    clip: vi.fn(),
  };

  const ctx = raw as unknown as CanvasRenderingContext2D;

  const spies = {
    fillText: fillTextSpy,
    strokeText: strokeTextSpy,
    fillRect: fillRectSpy,
    fill: fillSpy,
    measureText: measureTextSpy,
    fillStyleHistory,
  };

  return { ctx, spies };
}

const SIZE = { width: 120, height: 48 };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("renderStyleThumbnail (static look — no animation)", () => {
  describe("stroke", () => {
    it("calls strokeText when the style has a stroke (outline)", () => {
      const outline = CAPTION_STYLES.find((s) => s.id === "outline")!;
      const { ctx, spies } = makeFakeCtx();
      renderStyleThumbnail(outline, ctx, SIZE);
      expect(spies.strokeText).toHaveBeenCalled();
    });

    it("does NOT call strokeText for a style without a stroke (clean)", () => {
      const clean = CAPTION_STYLES.find((s) => s.id === "clean")!;
      const { ctx, spies } = makeFakeCtx();
      renderStyleThumbnail(clean, ctx, SIZE);
      expect(spies.strokeText).not.toHaveBeenCalled();
    });
  });

  describe("fill color is the style color (no highlight swap)", () => {
    it("paints the pop style in its yellow color", () => {
      const pop = CAPTION_STYLES.find((s) => s.id === "pop")!;
      const { ctx, spies } = makeFakeCtx();
      renderStyleThumbnail(pop, ctx, SIZE);
      expect(spies.fillStyleHistory).toContain(pop.color);
    });
  });

  describe("full sample text — no typewriter reveal", () => {
    it("renders the entire sample word in one fillText", () => {
      const outline = CAPTION_STYLES.find((s) => s.id === "outline")!;
      const { ctx, spies } = makeFakeCtx();
      renderStyleThumbnail(outline, ctx, SIZE, "Hello");
      const calls = spies.fillText.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const text = calls[calls.length - 1][0] as string;
      expect(text).toBe("Hello");
    });
  });

  describe("background plate", () => {
    it("calls fillRect/fill for boxed style", () => {
      const boxed = CAPTION_STYLES.find((s) => s.id === "boxed")!;
      expect(boxed.background).toBeDefined();
      const { ctx, spies } = makeFakeCtx();
      renderStyleThumbnail(boxed, ctx, SIZE);
      const usedRect = spies.fillRect.mock.calls.length > 0;
      const usedFill = spies.fill.mock.calls.length > 0;
      expect(usedRect || usedFill).toBe(true);
    });

    it("does NOT call fillRect or fill for a style without background (clean)", () => {
      const clean = CAPTION_STYLES.find((s) => s.id === "clean")!;
      expect(clean.background).toBeUndefined();
      const { ctx, spies } = makeFakeCtx();
      renderStyleThumbnail(clean, ctx, SIZE);
      expect(spies.fillRect).not.toHaveBeenCalled();
      expect(spies.fill).not.toHaveBeenCalled();
    });
  });

  describe("shadow", () => {
    it("renders text for a style with shadow (clean)", () => {
      const clean = CAPTION_STYLES.find((s) => s.id === "clean")!;
      expect(clean.shadow).toBeDefined();
      const { ctx, spies } = makeFakeCtx();
      renderStyleThumbnail(clean, ctx, SIZE);
      expect(spies.fillText).toHaveBeenCalled();
    });
  });

  describe("never throws for every bundled style", () => {
    for (const style of CAPTION_STYLES) {
      it(`${style.id} — no throw`, () => {
        const { ctx } = makeFakeCtx();
        expect(() => renderStyleThumbnail(style, ctx, SIZE)).not.toThrow();
      });
    }
  });

  describe("sample text", () => {
    it("uses the provided sampleText", () => {
      const clean = CAPTION_STYLES.find((s) => s.id === "clean")!;
      const { ctx, spies } = makeFakeCtx();
      renderStyleThumbnail(clean, ctx, SIZE, "Word");
      const calls = spies.fillText.mock.calls;
      expect(calls.some((c) => (c[0] as string).includes("Word"))).toBe(true);
    });

    it("uses default 'Aa' when no sampleText is passed", () => {
      const clean = CAPTION_STYLES.find((s) => s.id === "clean")!;
      const { ctx, spies } = makeFakeCtx();
      renderStyleThumbnail(clean, ctx, SIZE);
      const calls = spies.fillText.mock.calls;
      expect(calls.some((c) => (c[0] as string).includes("Aa"))).toBe(true);
    });

    it("a minimal custom style still renders", () => {
      const custom: CaptionStyle = {
        id: "custom",
        label: "Custom",
        source: "user",
        color: "#ff0000",
      };
      const { ctx, spies } = makeFakeCtx();
      expect(() => renderStyleThumbnail(custom, ctx, SIZE)).not.toThrow();
      expect(spies.fillText).toHaveBeenCalled();
    });
  });
});
