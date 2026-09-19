// Text wrap width follows the piece's REAL frame (QA 2026-09-18 recheck N4).
//
// An `add_overlay` text overlay has no `anchor`, so `buildComposition` lazily
// normalizes it to point text. The normalizer used to (a) measure the whole
// string including `\n`s, and (b) divide the rect width by a hardcoded 1920 —
// so a portrait (1080-wide) piece wrapped at 0.24 × 1080 ≈ 259 px and even
// "Line one" broke. The invariant under test: the renderer wraps at
// `frameWidth × maxWidthPct`, which must equal the authored `rect.width`, so
// the preview wraps exactly where the author's box said to.
import { describe, it, expect } from "vitest";
import { buildComposition } from "@/lib/composition/build-composition";
import { normalizeLegacyTextOverlay } from "@/lib/captions/legacy-normalize";
import { layoutTextOverlay } from "@/lib/captions/layout";
import { wrapText } from "@/lib/overlays/caption-style";
import type { Overlay, TextOverlay } from "@/lib/engine/types";

// The same approximate measurer buildComposition uses (chars × fontSize × 0.5).
const measureFor = (fontSizePx: number) => (s: string) => s.length * fontSizePx * 0.5;

function textOverlay(content: string, fontSize: number, rect: TextOverlay["rect"]): TextOverlay {
  return {
    id: "t1",
    kind: "text",
    startTime: 0,
    duration: 3,
    rect,
    z: 0,
    opacity: 1,
    content,
    font: `${fontSize}px Inter`,
    color: "#fff",
    align: "center",
    fontSize,
  } as TextOverlay;
}

/** Lines the preview renderer would draw, given the composition it builds. */
function previewLines(o: TextOverlay, frameWidth: number): string[] {
  const measure = measureFor(o.fontSize ?? 48);
  return layoutTextOverlay(
    {
      content: o.content,
      position: o.position!,
      anchor: o.anchor!,
      fontSizePx: o.fontSize ?? 48,
      lineHeight: o.lineHeight ?? 1.2,
      maxWidthPct: o.maxWidthPct,
      frameWidth,
    },
    measure,
  ).lines;
}

const FRAMES = [
  { name: "portrait 1080×1920", width: 1080, height: 1920 },
  { name: "landscape 1920×1080", width: 1920, height: 1080 },
] as const;

describe("text wrap width uses the piece's real frame", () => {
  for (const frame of FRAMES) {
    describe(frame.name, () => {
      it("returns a composition sized to the piece", () => {
        const comp = buildComposition(new Map(), [], [], { width: frame.width, height: frame.height, fps: 24 });
        expect(comp.width).toBe(frame.width);
        expect(comp.height).toBe(frame.height);
        expect(comp.fps).toBe(24);
      });

      it("multi-line text that fits per line does not wrap (the N4 repro)", () => {
        // 80px, rect 460 wide: longest line "Line three" ≈ 10 × 40 = 400 < 460.
        const o = textOverlay("Line one\nLine two\nLine three", 80, { x: 100, y: 100, width: 460, height: 300 });
        const comp = buildComposition(new Map(), [o as Overlay], [], { width: frame.width, height: frame.height });
        const out = comp.overlays![0] as TextOverlay;
        expect(out.maxWidthPct).toBeUndefined();
        expect(previewLines(out, frame.width)).toEqual(["Line one", "Line two", "Line three"]);
      });

      it("a single long line wraps at exactly the authored rect width", () => {
        const content = "This caption is much longer than the box it was authored into";
        const rect = { x: 90, y: 1200, width: 900, height: 200 };
        const o = textOverlay(content, 60, rect);
        const comp = buildComposition(new Map(), [o as Overlay], [], { width: frame.width, height: frame.height });
        const out = comp.overlays![0] as TextOverlay;
        expect(out.maxWidthPct! * frame.width).toBeCloseTo(rect.width, 6);
        expect(previewLines(out, frame.width)).toEqual(wrapText(measureFor(60), content, rect.width));
        expect(previewLines(out, frame.width).length).toBeGreaterThan(1);
      });

      it("multi-line text whose longest line overflows wraps at the rect width", () => {
        const content = "Short\nThis second line is far wider than the box";
        const rect = { x: 50, y: 50, width: 700, height: 300 };
        const o = textOverlay(content, 60, rect);
        const comp = buildComposition(new Map(), [o as Overlay], [], { width: frame.width, height: frame.height });
        const out = comp.overlays![0] as TextOverlay;
        expect(out.maxWidthPct! * frame.width).toBeCloseTo(rect.width, 6);
        expect(previewLines(out, frame.width)).toEqual(wrapText(measureFor(60), content, rect.width));
      });
    });
  }

  it("defaults to 1920×1080×30 when no dims are given (unchanged behavior)", () => {
    const comp = buildComposition(new Map(), []);
    expect([comp.width, comp.height, comp.fps]).toEqual([1920, 1080, 30]);
  });
});

describe("normalizeLegacyTextOverlay measures the widest line, not the whole string", () => {
  it("does not count newlines as width", () => {
    // Whole string: 28 chars × 40 = 1120 > 460 (old, wrong). Widest line: 400.
    const o = textOverlay("Line one\nLine two\nLine three", 80, { x: 0, y: 0, width: 460, height: 300 });
    expect(normalizeLegacyTextOverlay(o, 1080, measureFor(80)).maxWidthPct).toBeUndefined();
  });

  it("detects a wrap box from its widest line", () => {
    const o = textOverlay("ok\n" + "w".repeat(30), 80, { x: 0, y: 0, width: 460, height: 300 });
    expect(normalizeLegacyTextOverlay(o, 1080, measureFor(80)).maxWidthPct).toBeCloseTo(460 / 1080, 6);
  });
});
