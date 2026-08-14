"use client";

import { useCallback, useRef } from "react";
import type { Composition, TrackedOverlay, Transform3D } from "@/lib/engine/types";
import { screenToCompositionPoint } from "@/components/preview/reanchor-drag-math";
import { resolveOverlayTransform } from "@/lib/engine/overlay-transform";
import {
  trackedScaleFromDrag,
  spinTransformAt,
} from "@/lib/preview/tracked-handle-math";
import type { OverlayTransformPatch } from "@/hooks/editor/use-overlay-transform-commit";

/** Corner handle anchors (fractions of the art box). Corners ONLY — tracked
 *  sizing is the uniform `scale` field; per-axis stretch doesn't exist for it. */
const CORNERS: { id: string; fx: number; fy: number; cursor: string }[] = [
  { id: "nw", fx: 0, fy: 0, cursor: "nwse-resize" },
  { id: "ne", fx: 1, fy: 0, cursor: "nesw-resize" },
  { id: "se", fx: 1, fy: 1, cursor: "nwse-resize" },
  { id: "sw", fx: 0, fy: 1, cursor: "nesw-resize" },
];

interface TrackedTransformControlsProps {
  composition: Composition;
  /** The selected tracked overlay (live — re-renders as commits merge). */
  overlay: TrackedOverlay;
  /** Resolved art box at the playhead (resolveTrackedRect output), composition
   *  px. Recomputed by the caller each render, so the frame follows the art on
   *  scrub; the transform-UI gate hides it during playback. */
  artRect: { x: number; y: number; w: number; h: number };
  canvasDisplayWidth: number;
  canvasDisplayHeight: number;
  getCanvasBounds: () => DOMRect | null;
  /** Commit LIVE per pointer-move (edit-store paint + debounced PATCH). */
  onCommit: (patch: OverlayTransformPatch) => void;
  /** Force the debounced PATCH on pointer-up. */
  onFlush?: (overlayId: string) => void;
}

/**
 * Direct-manipulation frame for a TRACKED overlay, drawn on the RESOLVED art
 * box (track sample + fit/scale + follow offset — NOT the stored rect).
 * Corner handles write the track-relative `scale`; the rotate knob writes
 * `transform3d.rotation.z`. The interior is pointer-events-none ON PURPOSE:
 * a body drag must fall through to the canvas, where the existing gesture
 * stack lives (plain drag = follow-offset reposition; drag in "Adjust
 * tracking" = re-anchor; click = reveal). This component never writes `rect`.
 */
export function TrackedTransformControls({
  composition,
  overlay,
  artRect,
  canvasDisplayWidth,
  canvasDisplayHeight,
  getCanvasBounds,
  onCommit,
  onFlush,
}: TrackedTransformControlsProps) {
  const scaleX = composition.width > 0 ? canvasDisplayWidth / composition.width : 1;
  const scaleY = composition.height > 0 ? canvasDisplayHeight / composition.height : 1;
  const listenersRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null);

  const endGesture = useCallback(() => {
    const l = listenersRef.current;
    if (l) {
      window.removeEventListener("mousemove", l.move);
      window.removeEventListener("mouseup", l.up);
      listenersRef.current = null;
    }
  }, []);

  const toComp = useCallback(
    (ev: { clientX: number; clientY: number }) => {
      const bounds = getCanvasBounds();
      if (!bounds) return null;
      return screenToCompositionPoint(ev, bounds, composition.width, composition.height);
    },
    [getCanvasBounds, composition.width, composition.height],
  );

  const beginGesture = useCallback(
    (kind: "scale" | "rotate", e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation(); // never reach the canvas gesture stack
      const down = toComp(e);
      if (!down) return;
      // Capture the pointer-down anchors: the art box's center is
      // scale-invariant, so it stays valid while the live box grows.
      const startArt = artRect;
      const startScale = overlay.scale;
      const baseT3d: Transform3D = resolveOverlayTransform(overlay);

      const move = (ev: MouseEvent) => {
        const pt = toComp(ev);
        if (!pt) return;
        if (kind === "scale") {
          onCommit({ scale: trackedScaleFromDrag({ art: startArt, startScale, down, cur: pt }) });
        } else {
          onCommit({ transform3d: spinTransformAt(baseT3d, startArt, pt) });
        }
      };
      const up = () => {
        endGesture();
        onFlush?.(overlay.id);
      };
      listenersRef.current = { move, up };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [artRect, overlay, toComp, onCommit, onFlush, endGesture],
  );

  if (canvasDisplayWidth <= 0 || canvasDisplayHeight <= 0) return null;

  const spinDeg = (resolveOverlayTransform(overlay).rotation.z * 180) / Math.PI;
  const left = artRect.x * scaleX;
  const top = artRect.y * scaleY;
  const width = artRect.w * scaleX;
  const height = artRect.h * scaleY;

  return (
    <div
      data-testid="tracked-transform-controls"
      className="pointer-events-none absolute left-0 top-0"
      style={{
        left,
        top,
        width,
        height,
        transform: `rotate(${spinDeg}deg)`,
        transformOrigin: "center center",
        zIndex: 11,
      }}
    >
      {/* Outline only — NO move body. The interior stays click-through so the
          canvas gesture stack keeps owning reposition / re-anchor / reveal. */}
      <div className="absolute inset-0 rounded-sm border-2 border-amber-400/90" />
      {/* Rotate knob (above the top edge) → transform3d.rotation.z */}
      <div
        data-testid="tracked-rotate-handle"
        onMouseDown={(e) => beginGesture("rotate", e)}
        className="absolute left-1/2 size-3 -translate-x-1/2 cursor-grab rounded-full border-2 border-amber-400 bg-background"
        style={{ top: -24, pointerEvents: "auto" }}
      />
      {/* 4 corner handles → uniform track-relative scale */}
      {CORNERS.map((h) => (
        <div
          key={h.id}
          data-testid={`tracked-handle-${h.id}`}
          onMouseDown={(e) => beginGesture("scale", e)}
          className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-amber-400 bg-background"
          style={{
            left: `${h.fx * 100}%`,
            top: `${h.fy * 100}%`,
            pointerEvents: "auto",
            cursor: h.cursor,
          }}
        />
      ))}
    </div>
  );
}
