"use client";

import { useEffect, useRef } from "react";
import type { TextOverlay } from "@/lib/engine/types";

interface OverlayEditorProps {
  overlay: TextOverlay;
  compositionWidth: number;
  compositionHeight: number;
  canvasDisplayWidth: number;
  canvasDisplayHeight: number;
  onCommit: (content: string) => void;
  onCancel: () => void;
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

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      data-overlay-id={overlay.id}
      data-testid="overlay-editor"
      style={{
        position: "absolute",
        left: overlay.rect.x * scaleX,
        top: overlay.rect.y * scaleY,
        width: overlay.rect.width * scaleX,
        minHeight: overlay.rect.height * scaleY,
        font: overlay.font,
        color: overlay.color,
        textAlign: overlay.align,
        outline: "2px solid var(--primary)",
        background: "rgba(0,0,0,0.5)",
        padding: 4,
        boxSizing: "border-box",
        whiteSpace: "pre-wrap",
        zIndex: 10,
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
  );
}
