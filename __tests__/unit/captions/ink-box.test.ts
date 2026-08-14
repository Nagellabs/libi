import { describe, it, expect } from "vitest";
import { assembleInkBox, type LineInk } from "@/lib/captions/ink-box";

// The renderer (drawTextOverlay) places each wrapped line with textBaseline "top"
// at y = rect.y + yOffset + i*lineHeightPx, where
//   yOffset = max(0, (rect.height - lines*lineHeightPx) / 2).
// `assembleInkBox` must wrap the VISIBLE ink (not the line box) so an
// ascender-only caption is centered inside the selection box with even padding.

const lineHeightPx = 202.26;

// Real Chromium metrics for "hello world" @168.55px Inter, textBaseline "top":
//   width 772.38, inkAscentFromTop 10.857 (ink top below draw point),
//   inkDescentFromTop 128.957 (ink bottom below draw point).
const helloWorld: LineInk = {
  width: 772.38,
  inkAscentFromTop: 10.857,
  inkDescentFromTop: 128.957,
};

describe("assembleInkBox", () => {
  it("centers the box on the visible ink, not the line box, for ascender-only text", () => {
    // rect.height === lineHeightPx ⇒ yOffset 0 ⇒ glyphs drawn at rect.y.
    const rect = { x: 188.83, y: 573.25, width: 927.03, height: 202.26 };
    const box = assembleInkBox({
      rect,
      lines: [helloWorld],
      lineHeightPx,
      align: "center",
      padPx: 12,
    });
    // Ink spans y = 573.25+10.857 .. 573.25+128.957 = 584.107 .. 702.207.
    const inkTop = 573.25 + 10.857;
    const inkBottom = 573.25 + 128.957;
    expect(box.y).toBeCloseTo(inkTop - 12, 2);
    expect(box.height).toBeCloseTo(inkBottom - inkTop + 24, 2);
    // The box's vertical center equals the ink's vertical center (text centered).
    const inkCenter = (inkTop + inkBottom) / 2;
    expect(box.y + box.height / 2).toBeCloseTo(inkCenter, 2);
  });

  it("centers horizontally on the line center for center-aligned text", () => {
    const rect = { x: 100, y: 0, width: 900, height: lineHeightPx };
    const box = assembleInkBox({
      rect,
      lines: [helloWorld],
      lineHeightPx,
      align: "center",
      padPx: 10,
    });
    const cx = rect.x + rect.width / 2; // 550
    expect(box.x).toBeCloseTo(cx - helloWorld.width / 2 - 10, 2);
    expect(box.width).toBeCloseTo(helloWorld.width + 20, 2);
    // Box center == line center.
    expect(box.x + box.width / 2).toBeCloseTo(cx, 2);
  });

  it("left-aligns the ink box to rect.x for left-aligned text", () => {
    const rect = { x: 40, y: 0, width: 900, height: lineHeightPx };
    const box = assembleInkBox({
      rect,
      lines: [helloWorld],
      lineHeightPx,
      align: "left",
      padPx: 6,
    });
    expect(box.x).toBeCloseTo(rect.x - 6, 2);
  });

  it("right-aligns the ink box to rect.x+width for right-aligned text", () => {
    const rect = { x: 40, y: 0, width: 900, height: lineHeightPx };
    const box = assembleInkBox({
      rect,
      lines: [helloWorld],
      lineHeightPx,
      align: "right",
      padPx: 6,
    });
    const right = rect.x + rect.width; // 940
    expect(box.x + box.width).toBeCloseTo(right + 6, 2);
  });

  it("spans from the first line's ink top to the last line's ink bottom (multi-line)", () => {
    const rect = { x: 0, y: 0, width: 900, height: lineHeightPx * 2 };
    const lineA: LineInk = { width: 400, inkAscentFromTop: 12, inkDescentFromTop: 150 };
    const lineB: LineInk = { width: 600, inkAscentFromTop: 12, inkDescentFromTop: 150 };
    const box = assembleInkBox({
      rect,
      lines: [lineA, lineB],
      lineHeightPx,
      align: "center",
      padPx: 0,
    });
    // yOffset 0; line0 top draw at y=0, line1 top draw at y=lineHeightPx.
    const inkTop = 0 + lineA.inkAscentFromTop;
    const inkBottom = lineHeightPx + lineB.inkDescentFromTop;
    expect(box.y).toBeCloseTo(inkTop, 2);
    expect(box.height).toBeCloseTo(inkBottom - inkTop, 2);
    // Width follows the widest line.
    expect(box.width).toBeCloseTo(600, 2);
  });

  it("respects yOffset when rect.height exceeds the text block (vertical centering)", () => {
    const rect = { x: 0, y: 100, width: 900, height: lineHeightPx * 3 }; // tall rect, 1 line
    const box = assembleInkBox({
      rect,
      lines: [helloWorld],
      lineHeightPx,
      align: "center",
      padPx: 0,
    });
    const yOffset = (rect.height - lineHeightPx) / 2; // text block centered in tall rect
    const inkTop = rect.y + yOffset + helloWorld.inkAscentFromTop;
    expect(box.y).toBeCloseTo(inkTop, 2);
  });

  it("falls back to the line box when there are no lines (empty content)", () => {
    const rect = { x: 5, y: 6, width: 7, height: 8 };
    const box = assembleInkBox({ rect, lines: [], lineHeightPx, align: "center", padPx: 3 });
    expect(box).toEqual(rect);
  });
});
