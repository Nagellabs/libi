// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { OverlayEditor, canvasTextLift, measureCanvasFont } from "@/components/preview/overlay-editor";
import type { TextOverlay } from "@/lib/engine/types";

function makeOverlay(over: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: "ov1",
    kind: "text",
    content: "TILT TEST",
    font: "48px Inter",
    color: "#fff",
    align: "center",
    fontSize: 48,
    opacity: 1,
    rect: { x: 100, y: 100, width: 400, height: 80 },
    startTime: 0,
    duration: 2,
    z: 1,
    ...over,
  };
}

const baseProps = {
  compositionWidth: 1920,
  compositionHeight: 1080,
  canvasDisplayWidth: 480,
  canvasDisplayHeight: 270,
};

describe("OverlayEditor — content is uncontrolled (no clobber on external update)", () => {
  it("seeds the initial content on mount", () => {
    const { getByTestId } = render(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay()}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(getByTestId("overlay-editor").textContent).toBe("TILT TEST");
  });

  it("does NOT clobber an in-progress edit when the overlay's content changes externally", () => {
    const onCommit = vi.fn();
    const { getByTestId, rerender } = render(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay()}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );
    const editor = getByTestId("overlay-editor");

    // User edits the caption inline (the browser mutates the contentEditable DOM).
    editor.textContent = "TILT TEST EDITED";

    // An EXTERNAL update arrives mid-edit (e.g. an agent PATCH or another tool
    // changes the caption text) — the live composition refetches, so the editor
    // re-renders with a new overlay object whose `content` differs.
    rerender(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay({ content: "EXTERNAL CHANGE", fontSize: 64 })}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );

    // The user's in-progress edit MUST survive — React must not reconcile the
    // external content into the dirtied contentEditable.
    expect(editor.textContent).toBe("TILT TEST EDITED");

    // And committing on blur writes the user's text, not the external value.
    fireEvent.blur(editor);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("TILT TEST EDITED");
  });

  it("a style-only external re-render also leaves the edit intact", () => {
    const onCommit = vi.fn();
    const { getByTestId, rerender } = render(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay()}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );
    const editor = getByTestId("overlay-editor");
    editor.textContent = "EDIT IN PROGRESS";

    // Same content, different geometry (a handle drag committing fontSize/rect).
    rerender(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay({ fontSize: 96, rect: { x: 50, y: 50, width: 600, height: 120 } })}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );

    expect(editor.textContent).toBe("EDIT IN PROGRESS");
    fireEvent.blur(editor);
    expect(onCommit).toHaveBeenCalledWith("EDIT IN PROGRESS");
  });
});

describe("OverlayEditor — inline style uses the real composed font", () => {
  it("reflects fontWeight/fontSize/fontFamily even when the stale `font` field disagrees", () => {
    // overlay.font is a stale "48px Inter" default (set once at creation,
    // mcp/tools/overlay-tools.ts) — the structured fields are what the
    // renderer actually paints with (composeFont). The inline editor must
    // match the renderer, not the stale field, or the WYSIWYG edit box shows
    // the wrong font while typing.
    const { getByTestId } = render(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay({
          font: "48px Inter",
          fontSize: 96,
          fontWeight: 700,
          fontFamily: "Georgia",
        })}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    const editor = getByTestId("overlay-editor");
    // Weight + family from the structured fields; size scaled to the preview
    // (96 × 270/1080 = 24) — see the display-scale block below.
    // (jsdom folds the separate lineHeight into the serialized shorthand.)
    expect(editor.style.font).toMatch(/^700 24px( \/ [\d.]+)? Georgia$/);
  });
});

// QA 2026-09-19 D2: the editor scaled its rect to the preview but drew the
// text at the COMPOSITION px size (96 px vs ~30.6 px on the canvas), so it
// wrapped and spilled out of the preview.
describe("OverlayEditor — font size is scaled to the preview like the rect", () => {
  function fontSizePx(el: HTMLElement): number {
    const m = /(\d+(?:\.\d+)?)px/.exec(el.style.font);
    if (!m) throw new Error(`no px size in font "${el.style.font}"`);
    return Number(m[1]);
  }

  it("draws fontSize × (display height / composition height) — the QA layout (scale 0.319)", () => {
    const scale = 344.52 / 1080; // ≈ 0.319
    const { getByTestId } = render(
      <OverlayEditor
        compositionWidth={1920}
        compositionHeight={1080}
        canvasDisplayWidth={1920 * scale}
        canvasDisplayHeight={344.52}
        overlay={makeOverlay({ font: "48px Inter", fontSize: 96, fontWeight: 700 })}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    const editor = getByTestId("overlay-editor");
    expect(fontSizePx(editor)).toBeCloseTo(96 * scale, 2); // ≈ 30.6, not 96
    expect(editor.style.font).toMatch(/^700 [\d.]+px( \/ [\d.]+)? Inter$/);
  });

  it("scales a legacy font string with no structured fields too", () => {
    const { getByTestId } = render(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay({ font: "bold 48px Inter", fontSize: undefined })}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(fontSizePx(getByTestId("overlay-editor"))).toBeCloseTo(12, 5); // 48 × 0.25
  });

  it("keeps the renderer's unitless line height so wrapped lines scale with the font", () => {
    const { getByTestId } = render(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay({ lineHeight: 1.4 })}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(getByTestId("overlay-editor").style.font).toMatch(/\/ ?1\.4 /);
  });

  // QA re-verification N1: a separate `lineHeight` style fell back to "normal"
  // when the preview resized mid-edit and React re-applied the `font`
  // shorthand. The line height now rides inside the shorthand.
  it("keeps the line height when the preview resizes mid-edit", () => {
    const overlay = makeOverlay({ lineHeight: 1.4 });
    const { getByTestId, rerender } = render(
      <OverlayEditor {...baseProps} overlay={overlay} onCommit={() => {}} onCancel={() => {}} />,
    );
    rerender(
      <OverlayEditor
        {...baseProps}
        canvasDisplayWidth={baseProps.canvasDisplayWidth * 2}
        canvasDisplayHeight={baseProps.canvasDisplayHeight * 2}
        overlay={overlay}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    const font = getByTestId("overlay-editor").style.font;
    expect(fontSizePx(getByTestId("overlay-editor"))).toBeCloseTo(48 * 0.5, 5);
    expect(font).toMatch(/\/ ?1\.4 /);
  });
});

// QA 2026-09-19 "Re-verification" Observation: the renderer (drawTextOverlay)
// always vertically CENTERS the wrapped text block within `rect` — clamped to
// the top when the text overflows it (yOffset = max(0, (rect.height -
// totalTextHeight) / 2)). It is the only vertical placement the renderer
// supports for a text overlay's content (the 9-point `anchor` only controls
// where the RECT itself is placed, via layoutTextOverlay — never how text
// sits inside it once placed). The editor previously top-aligned its text
// against the box, landing the caret text ~8px above the canvas-drawn glyphs
// whenever rect.height didn't exactly hug the (wrapped) text.
describe("OverlayEditor — vertical placement matches the renderer's centering", () => {
  it("centers the text block in a flex-column FRAME at the rect, like drawTextOverlay's yOffset", () => {
    const { getByTestId } = render(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay()}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    const frame = getByTestId("overlay-editor-frame");
    expect(frame.style.display).toBe("flex");
    expect(frame.style.flexDirection).toBe("column");
    expect(frame.style.justifyContent).toBe("center");
    // the rect, scaled 0.25: 100,100 400×80 → 25,25 100×20
    expect([frame.style.left, frame.style.top, frame.style.width, frame.style.minHeight]).toEqual(["25px", "25px", "100px", "20px"]);
    // the editable text lives inside the frame
    expect(frame.contains(getByTestId("overlay-editor"))).toBe(true);
  });

  // QA 2026-09-19 Q2: 4 px of top padding moved overflowing text 4 px below
  // the renderer's, which clamps the block to rect.y exactly.
  it("has no vertical padding, so an overflowing block starts at rect.y like the renderer's clamp", () => {
    const { getByTestId } = render(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay()}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    const style = getByTestId("overlay-editor-frame").style;
    expect(style.paddingTop).toBe("0px");
    expect(style.paddingBottom).toBe("0px");
  });

  it("holds for every horizontal align the renderer supports (vertical centering is align-independent)", () => {
    for (const align of ["left", "center", "right"] as const) {
      const { getByTestId, unmount } = render(
        <OverlayEditor
          {...baseProps}
          overlay={makeOverlay({ align })}
          onCommit={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(getByTestId("overlay-editor-frame").style.justifyContent).toBe("center");
      expect(getByTestId("overlay-editor").style.textAlign).toBe(align);
      unmount();
    }
  });
});

// QA 2026-09-19 Q2: the canvas draws each line from its EM-BOX top
// (textBaseline "top"); CSS puts the baseline half-leading + the font's ascent
// below the line top. For Inter at line height 1.2 that is 0.163 em lower —
// 5 px at the QA's 30.6 px. The editable text is lifted by exactly that.
describe("canvasTextLift — how far CSS text sits below the canvas's", () => {
  // Inter's font-box metrics (hhea): ascent 0.96875 em, descent 0.2421875 em;
  // Chromium's em box splits 1 em in the same ratio (emHeightAscent 0.8 em).
  const inter = (px: number) => ({ fontAscent: 0.96875 * px, fontDescent: 0.2421875 * px, emAscent: 0.8 * px });

  it("is half-leading + font ascent − em ascent (the QA layout: 30.578 px Inter, 1.2)", () => {
    expect(canvasTextLift(inter(30.578), 30.578, 1.2)).toBeCloseTo(4.99, 2);
  });

  it("scales with the font and depends on the line height only through the half-leading", () => {
    expect(canvasTextLift(inter(96), 96, 1.2)).toBeCloseTo(15.675, 3);
    expect(canvasTextLift(inter(96), 96, 1.6) - canvasTextLift(inter(96), 96, 1.2)).toBeCloseTo(0.2 * 96, 5);
  });

  it("is 0 without metrics (no canvas, e.g. jsdom)", () => {
    expect(canvasTextLift(null, 30, 1.2)).toBe(0);
  });

  it("the editor applies it as a relative lift on the editable text only (the frame stays at the rect)", () => {
    const { getByTestId } = render(
      <OverlayEditor
        {...baseProps}
        overlay={makeOverlay()}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    const editor = getByTestId("overlay-editor");
    expect(editor.style.position).toBe("relative");
    // jsdom has no canvas → no metrics → no lift
    expect(editor.style.top).toBe("0px");
    expect(getByTestId("overlay-editor-frame").style.top).toBe("25px");
  });
});

// Review of Q2: the em ascent is read from `alphabeticBaseline` at textBaseline
// "top", which Chromium reports as NEGATIVE. An engine with the opposite sign,
// or implausible numbers, must not lift the editor text a whole line.
describe("measureCanvasFont — sign-agnostic, falls back on implausible metrics", () => {
  function stubCanvas(m: { fontAscent: number; fontDescent: number; alphabeticAtTop: number }) {
    const ctx = {
      font: "",
      textBaseline: "alphabetic",
      measureText() {
        return this.textBaseline === "top"
          ? { alphabeticBaseline: m.alphabeticAtTop }
          : { fontBoundingBoxAscent: m.fontAscent, fontBoundingBoxDescent: m.fontDescent };
      },
    };
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return ctx;
        }
      },
    );
  }

  it("reads the em ascent from a negative (Chromium) baseline", () => {
    stubCanvas({ fontAscent: 29, fontDescent: 7, alphabeticAtTop: -24 });
    expect(measureCanvasFont("30px Inter")).toEqual({ fontAscent: 29, fontDescent: 7, emAscent: 24 });
    vi.unstubAllGlobals();
  });

  it("gives the same answer for the opposite sign convention", () => {
    stubCanvas({ fontAscent: 29, fontDescent: 7, alphabeticAtTop: 24 });
    expect(measureCanvasFont("30px Inter")?.emAscent).toBe(24);
    vi.unstubAllGlobals();
  });

  it("falls back (no lift) when the em ascent exceeds the font ascent or is zero", () => {
    stubCanvas({ fontAscent: 29, fontDescent: 7, alphabeticAtTop: -40 });
    expect(measureCanvasFont("30px Inter")).toBeNull();
    stubCanvas({ fontAscent: 29, fontDescent: 7, alphabeticAtTop: 0 });
    expect(measureCanvasFont("30px Inter")).toBeNull();
    vi.unstubAllGlobals();
  });
});
