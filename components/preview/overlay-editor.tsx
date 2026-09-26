"use client";

import { useEffect, useMemo, useRef } from "react";
import type { TextOverlay } from "@/lib/engine/types";
import { textOverlayFontString } from "@/lib/engine/overlay-renderer";

interface OverlayEditorProps {
  overlay: TextOverlay;
  compositionWidth: number;
  compositionHeight: number;
  canvasDisplayWidth: number;
  canvasDisplayHeight: number;
  onCommit: (content: string) => void;
  onCancel: () => void;
}

/** Scale the `<n>px` size token of a CSS font shorthand (as composed by
 *  `textOverlayFontString`, or a legacy hand-written `font` string) and put
 *  the line height INSIDE the shorthand: a separate `lineHeight` style is
 *  reset to "normal" whenever React re-applies a changed `font` (a preview
 *  resize mid-edit), and React warns about the shorthand/longhand conflict. */
function scaledFontShorthand(font: string, scale: number, lineHeight: number): string {
  return font.replace(
    /(\d+(?:\.\d+)?)px(?:\/\S+)?/,
    (_, n: string) => `${Number((Number(n) * scale).toFixed(3))}px/${lineHeight}`,
  );
}

/** The font-box and em-box ascents of a font, in px (`measureText` with
 *  textBaseline "alphabetic"). */
export interface CanvasFontMetrics {
  fontAscent: number;
  fontDescent: number;
  emAscent: number;
}

/**
 * How far below the canvas's text CSS lays the same text out, in px of the
 * font given — the amount to lift the editor's text by.
 *
 * The renderer draws each line with textBaseline "top": the EM-BOX top sits at
 * the line top, so the baseline is `emAscent` below it. CSS centres the font's
 * content box (ascent + descent) in the line box, so its baseline is the
 * half-leading plus `fontAscent` below the line top. Both step lines by the
 * same fontSize × lineHeight, so one constant lift aligns every line.
 * For Inter at 1.2 it is 0.163 em — 5 px at 30.6 px (QA 2026-09-19 Q2).
 */
export function canvasTextLift(
  metrics: CanvasFontMetrics | null,
  fontSizePx: number,
  lineHeight: number,
): number {
  if (!metrics) return 0;
  const halfLeading = (fontSizePx * lineHeight - (metrics.fontAscent + metrics.fontDescent)) / 2;
  return halfLeading + metrics.fontAscent - metrics.emAscent;
}

/** Metrics for a canvas font string, or null where the canvas can't report
 *  them (jsdom, very old engines). `emHeightAscent` is still behind a flag in
 *  Chromium, so the em-box ascent is read instead as how far the alphabetic
 *  baseline sits below the "top" (em-box top) baseline, which ships. */
export function measureCanvasFont(font: string): CanvasFontMetrics | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  const ctx = new OffscreenCanvas(1, 1).getContext("2d");
  if (!ctx) return null;
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  const a = ctx.measureText("H");
  ctx.textBaseline = "top";
  const t = ctx.measureText("H");
  if (
    typeof a.fontBoundingBoxAscent !== "number" ||
    typeof a.fontBoundingBoxDescent !== "number" ||
    typeof t.alphabeticBaseline !== "number"
  ) {
    return null;
  }
  // Chromium reports the alphabetic baseline as a distance ABOVE the "top"
  // line (negative); take the magnitude so an engine with the opposite sign
  // convention gets the same em ascent, and fall back (no lift) when the
  // numbers aren't plausible rather than shifting the text a whole line.
  const emAscent = Math.abs(t.alphabeticBaseline);
  const fontAscent = a.fontBoundingBoxAscent;
  if (!(emAscent > 0) || !(fontAscent > 0) || emAscent > fontAscent * 1.01) return null;
  return { fontAscent, fontDescent: a.fontBoundingBoxDescent, emAscent };
}

/** The first `<n>px` size in a CSS font shorthand. */
function fontSizeOf(font: string): number | null {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : null;
}

/**
 * Absolute-positioned inline editor rendered on top of the preview canvas
 * at the overlay's rect. Commits on blur or Enter; cancels on Escape.
 *
 * Positioned in screen-space using the canvas's display size — the overlay
 * rect is in composition-pixel space, so we scale it into display coords.
 */
export function OverlayEditor({
  overlay,
  compositionWidth,
  compositionHeight,
  canvasDisplayWidth,
  canvasDisplayHeight,
  onCommit,
  onCancel,
}: OverlayEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const initialRef = useRef(overlay.content);
  const committedRef = useRef(false);

  useEffect(() => {
    // Seed the contentEditable's text ONCE, imperatively. The text is then
    // fully uncontrolled — we never render `overlay.content` as a React child
    // (see the empty element below), so a re-render from an external
    // composition update (an agent PATCH, a handle drag, an inspector edit)
    // can never reconcile new text into the user's in-progress DOM edit and
    // clobber/corrupt it. Regression: __tests__/unit/preview/overlay-editor-content.test.tsx.
    if (ref.current) ref.current.textContent = initialRef.current;
    ref.current?.focus();
    const sel = window.getSelection();
    if (sel && ref.current) {
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, []);

  const scaleX = compositionWidth > 0 ? canvasDisplayWidth / compositionWidth : 1;
  const scaleY = compositionHeight > 0 ? canvasDisplayHeight / compositionHeight : 1;

  const lineHeight = overlay.lineHeight ?? 1.2;
  // Scaled to the preview exactly like the rect: the overlay's font is in
  // composition px, so drawing it unscaled made the editor text ~3× the canvas
  // text at a normal editor size (QA 2026-09-19 D2). Line height rides in the
  // shorthand, unitless like the renderer's multiplier, so it scales too.
  const font = scaledFontShorthand(textOverlayFontString(overlay), scaleY, lineHeight);
  // Measured on the SAME font the canvas draws with, then taken to display px.
  const lift = useMemo(() => {
    const compFont = textOverlayFontString(overlay);
    const size = fontSizeOf(compFont);
    if (!size) return 0;
    return canvasTextLift(measureCanvasFont(compFont), size, lineHeight) * scaleY;
  }, [overlay, lineHeight, scaleY]);

  return (
    <div
      data-testid="overlay-editor-frame"
      style={{
        position: "absolute",
        left: overlay.rect.x * scaleX,
        top: overlay.rect.y * scaleY,
        width: overlay.rect.width * scaleX,
        minHeight: overlay.rect.height * scaleY,
        outline: "2px solid var(--primary)",
        background: "rgba(0,0,0,0.5)",
        // Horizontal breathing room only. The renderer knows no padding: its
        // text block starts at rect.y when it overflows, so any top padding
        // here pushed overflowing text down by that much (QA 2026-09-19 Q2).
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 4,
        paddingRight: 4,
        boxSizing: "border-box",
        zIndex: 10,
        cursor: "text",
        // The renderer (drawTextOverlay, lib/engine/overlay-renderer.ts) always
        // vertically centers the wrapped text block within `rect` — clamped to
        // the top when the text is taller than the rect (yOffset = max(0, …)).
        // A flex column with justifyContent:"center" reproduces both: while the
        // frame's minHeight covers the content it centers it, and once the
        // content grows past minHeight the frame (which has no fixed height)
        // grows to fit it, leaving no slack to center — i.e. content sits at
        // the top, matching the clamp.
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
      }}
      // A press on the frame around the text keeps editing rather than
      // blurring (= committing), as it did when the frame was the editable.
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        ref.current?.focus();
      }}
    >
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        data-overlay-id={overlay.id}
        data-testid="overlay-editor"
        style={{
          font,
          color: overlay.color,
          textAlign: overlay.align,
          whiteSpace: "pre-wrap",
          outline: "none",
          // CSS sets each line's baseline lower than the canvas does (see
          // canvasTextLift); lift the text, not the frame, by the difference.
          position: "relative",
          top: -lift,
        }}
        onBlur={(e) => {
          if (committedRef.current) return;
          committedRef.current = true;
          onCommit(e.currentTarget.textContent ?? "");
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            committedRef.current = true;
            if (ref.current) ref.current.textContent = initialRef.current;
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            (e.currentTarget as HTMLDivElement).blur();
          }
        }}
      />
    </div>
  );
}
