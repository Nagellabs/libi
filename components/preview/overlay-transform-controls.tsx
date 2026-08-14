"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { Composition, Overlay, OverlayRect, TextOverlay, Transform3D } from "@/lib/engine/types";
import { screenToCompositionPoint } from "@/components/preview/reanchor-drag-math";
import {
  applyMoveDrag,
  applyResizeDrag,
  applyRotateDrag,
  type HandleId,
} from "@/lib/preview/overlay-drag-math";
import { clampRectToFrame } from "@/lib/engine/overlays";
import { resolveOverlayTransform, resolveFlip, classifyTransform, splitScreenRoll, rotatePointAround } from "@/lib/engine/overlay-transform";
import { projectSpatialQuadFootprint } from "@/lib/engine/overlay-quad-projection";
import { effectiveTextRect, textOverlayFontString } from "@/lib/engine/overlay-renderer";
import type { OverlayTransformPatch } from "@/hooks/editor/use-overlay-transform-commit";
import { useOverlayEditStore } from "@/lib/preview/overlay-edit-context";

/**
 * A once-created hidden 2D context used solely to measure text — mirrors the
 * renderer's scratch-canvas measure path so the selection box matches the
 * painted glyphs. Lazily created (and only in the browser).
 */
let measureCtx: CanvasRenderingContext2D | null | undefined;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx;
  if (typeof document === "undefined") {
    measureCtx = null;
    return null;
  }
  measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx;
}

/**
 * The MEASURED point-text box for a text overlay, in composition pixels — the
 * same rect the renderer derives via `effectiveTextRect`, so the selection box
 * wraps the actual rendered text rather than the stale stored `overlay.rect`.
 * Returns null when measurement isn't available (SSR / no canvas).
 */
function measuredTextRect(overlay: TextOverlay, compositionWidth: number): OverlayRect | null {
  const ctx = getMeasureCtx();
  if (!ctx) return null;
  ctx.font = textOverlayFontString(overlay);
  const r = effectiveTextRect(overlay, (s) => ctx.measureText(s).width, compositionWidth);
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** The 8 handle ids + their CSS anchor (fractions of the rect). */
const HANDLES: { id: HandleId; fx: number; fy: number; cursor: string }[] = [
  { id: "nw", fx: 0, fy: 0, cursor: "nwse-resize" },
  { id: "n", fx: 0.5, fy: 0, cursor: "ns-resize" },
  { id: "ne", fx: 1, fy: 0, cursor: "nesw-resize" },
  { id: "e", fx: 1, fy: 0.5, cursor: "ew-resize" },
  { id: "se", fx: 1, fy: 1, cursor: "nwse-resize" },
  { id: "s", fx: 0.5, fy: 1, cursor: "ns-resize" },
  { id: "sw", fx: 0, fy: 1, cursor: "nesw-resize" },
  { id: "w", fx: 0, fy: 0.5, cursor: "ew-resize" },
];

interface OverlayTransformControlsProps {
  /** Live composition (for frame dims). */
  composition: Composition;
  /** The selected overlay (already resolved from the live composition by id). */
  overlay: Overlay;
  /** Canvas display size in CSS px. */
  canvasDisplayWidth: number;
  canvasDisplayHeight: number;
  /** The canvas element rect provider — for screen→composition mapping. */
  getCanvasBounds: () => DOMRect | null;
  /** Whether this overlay is editor-locked (suppresses all handles). */
  locked?: boolean;
  /** Commit the changed fields LIVE on each pointer-move so the painted content
   *  tracks the gesture (writes the edit store; debounced background PATCH). */
  onCommit: (patch: OverlayTransformPatch) => void;
  /** Force the debounced PATCH NOW on pointer-up (one PATCH per gesture). */
  onFlush?: (overlayId: string) => void;
  /** Render the box + handles at THIS rect (composition space) instead of
   *  `overlay.rect`, and run the drag math in this display space. Used by the
   *  `three` gizmo to hug the projected content rect. Defaults to `overlay.rect`
   *  — existing callers pass nothing → behavior is byte-identical. */
  displayRect?: OverlayRect;
  /** Transform a committed DISPLAY-space rect back to the model rect before
   *  `onCommit({ rect })`. Defaults to identity — existing callers pass nothing
   *  → the committed rect is the display rect unchanged. */
  mapRectCommit?: (displayRect: OverlayRect) => OverlayRect;
}

type Gesture =
  | { kind: "move"; startRect: OverlayRect; downX: number; downY: number }
  | {
      kind: "resize";
      handle: HandleId;
      startRect: OverlayRect;
      rotation: number;
      downX: number;
      downY: number;
    }
  | { kind: "rotate" };

/**
 * Direct-manipulation transform frame over the preview canvas. Reads scale from
 * the canvas display size (mirrors overlay-editor.tsx); maintains a local
 * optimistic override during a gesture so the box glides at refresh rate; calls
 * onCommit once on pointer-up. Pure drag math lives in lib/preview/overlay-drag-math.
 */
export function OverlayTransformControls({
  composition,
  overlay,
  canvasDisplayWidth,
  canvasDisplayHeight,
  getCanvasBounds,
  locked = false,
  onCommit,
  onFlush,
  displayRect,
  mapRectCommit,
}: OverlayTransformControlsProps) {
  const scaleX = composition.width > 0 ? canvasDisplayWidth / composition.width : 1;
  const scaleY = composition.height > 0 ? canvasDisplayHeight / composition.height : 1;
  const scale = { scaleX, scaleY };
  // Inline edit store: per-move we write the in-flight rect/rotation as a
  // PREVIEW (NO commit → NO React recomposite) and the canvas repaints via the
  // store's imperative channel.
  const editStore = useOverlayEditStore();

  // Local optimistic override during a drag; null ⇒ render from `overlay`.
  const [override, setOverride] = useState<{ rect: OverlayRect; rotation: number } | null>(
    null,
  );
  const gestureRef = useRef<Gesture | null>(null);
  // Latest live override computed during the gesture; read on pointer-up so the
  // final commit runs SYNCHRONOUSLY (before flush) instead of inside a setOverride
  // updater that React defers to the render after flush.
  const liveOverrideRef = useRef<{
    rect: OverlayRect;
    rotation: number;
    // Built during a rotate gesture: the in-plane spin always goes onto
    // transform3d.rotation.z (the SINGLE rotation authority). A move/resize
    // leaves this unset — it only carries the rect.
    t3d?: Transform3D;
  } | null>(null);
  const listenersRef = useRef<{
    move: (e: MouseEvent) => void;
    up: (e: MouseEvent) => void;
  } | null>(null);

  // For TEXT overlays the rendered glyphs come from a re-measured box
  // (`effectiveTextRect`), NOT the stored `overlay.rect` — so the selection box
  // must derive from that same measured rect to wrap the actual text. Recomputed
  // only when a field that affects layout changes. During a DRAG the override
  // rect wins (the user is actively moving/resizing); the measured rect is the
  // resting-display source. Non-text kinds always frame on `overlay.rect`.
  const textOverlay = overlay.kind === "text" ? (overlay as TextOverlay) : null;
  const measuredRect = useMemo(() => {
    if (!textOverlay) return null;
    return measuredTextRect(textOverlay, composition.width);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    textOverlay,
    composition.width,
    textOverlay?.content,
    textOverlay?.font,
    textOverlay?.fontFamily,
    textOverlay?.fontSize,
    textOverlay?.fontWeight,
    textOverlay?.fontFileId,
    textOverlay?.lineHeight,
    textOverlay?.maxWidthPct,
    textOverlay?.anchor,
    textOverlay?.position?.x,
    textOverlay?.position?.y,
    textOverlay?.rect.x,
    textOverlay?.rect.y,
    textOverlay?.rect.width,
    textOverlay?.rect.height,
  ]);

  // Source rect for the box + drag math. Defaults to the stored `overlay.rect`;
  // a caller (the `three` gizmo) may override it with a projected CONTENT rect so
  // the box hugs the visible content and the gesture math runs in that space. The
  // committed display-space rect is mapped back to the model rect via mapCommit.
  const sourceRect = displayRect ?? overlay.rect;
  const mapCommit = mapRectCommit ?? ((r: OverlayRect) => r);

  // Resting display rect: measured box for text (when available), else the source
  // rect. A live drag override always takes precedence over both.
  const restingRect = measuredRect ?? sourceRect;
  const liveRect = override?.rect ?? restingRect;
  const resolved = resolveOverlayTransform(overlay);
  const { spatial: resolvedNoRoll, rollRad } = splitScreenRoll(resolved);
  const rollDeg = (rollRad * 180) / Math.PI;
  // Every overlay's in-plane roll is transform3d.rotation.z (the single rotation
  // authority), so the gizmo box's rest angle always comes from rollDeg; an
  // active rotate drag overrides it live.
  const liveRotation = override?.rotation ?? rollDeg;

  const endGesture = useCallback(() => {
    const l = listenersRef.current;
    if (l) {
      window.removeEventListener("mousemove", l.move);
      window.removeEventListener("mouseup", l.up);
      listenersRef.current = null;
    }
    gestureRef.current = null;
  }, []);

  const beginGesture = useCallback(
    (g: Gesture, e: React.MouseEvent) => {
      if (locked) return;
      e.preventDefault();
      e.stopPropagation();
      gestureRef.current = g;
      liveOverrideRef.current = null;
      const downX = e.clientX;
      const downY = e.clientY;

      const move = (ev: MouseEvent) => {
        const cur = gestureRef.current;
        if (!cur) return;
        if (cur.kind === "move") {
          const rect = clampRectToFrame(
            applyMoveDrag(
              cur.startRect,
              { dxDisplay: ev.clientX - cur.downX, dyDisplay: ev.clientY - cur.downY },
              scale,
              rollDeg,
            ),
            composition.width,
            composition.height,
          );
          liveOverrideRef.current = { rect, rotation: liveRotation };
          setOverride({ rect, rotation: liveRotation });
          // Paint the content this frame via the edit store's PREVIEW channel —
          // no commit, no React recomposite. A move carries the RECT ONLY (spin is
          // not part of a move); the box renders at the DISPLAY rect and the
          // painted content tracks via mapCommit. Commits on pointer-up.
          editStore.preview(overlay.id, { rect: mapCommit(rect) });
        } else if (cur.kind === "resize") {
          const resized = applyResizeDrag(
            cur.startRect,
            cur.handle,
            { dxDisplay: ev.clientX - cur.downX, dyDisplay: ev.clientY - cur.downY },
            scale,
            cur.rotation,
          );
          liveOverrideRef.current = { rect: resized, rotation: cur.rotation };
          setOverride({ rect: resized, rotation: cur.rotation });
          // A resize carries the RECT ONLY — the spin (cur.rotation, seeded from
          // rollDeg) only inverse-rotates the resize delta; it is not re-committed.
          editStore.preview(overlay.id, { rect: mapCommit(resized) });
        } else {
          const bounds = getCanvasBounds();
          if (!bounds) return;
          const pt = screenToCompositionPoint(
            ev,
            bounds,
            composition.width,
            composition.height,
          );
          const rotation = applyRotateDrag(overlay.rect, { compX: pt.x, compY: pt.y });
          // The single rotation authority: write the spin onto
          // transform3d.rotation.z for EVERY overlay, preserving any
          // Elevation/Angle/Depth. A plain overlay (no transform3d) gets one
          // created off identity — there is no legacy `rotation` field anymore.
          const base = resolveOverlayTransform(overlay);
          const t3d: Transform3D = {
            ...base,
            rotation: { ...base.rotation, z: (rotation * Math.PI) / 180 },
          };
          liveOverrideRef.current = { rect: liveRect, rotation, t3d };
          setOverride({ rect: liveRect, rotation });
          // A rotate never changes the rect — preview transform3d ONLY. (Sending
          // `liveRect` here would push the gizmo's display/content rect into the
          // model rect for a `three`, shrinking its viewport mid-spin.)
          editStore.preview(overlay.id, { transform3d: t3d });
        }
      };

      const up = () => {
        endGesture();
        // Hand-off without flicker: the per-move PREVIEW kept the canvas on the
        // dragged value; COMMIT the final diff (flips that preview entry to
        // committed — one React render painting the SAME value), then flush. The
        // committed patch keeps painting until the PATCH lands + `confirm` drops
        // it, so there's no frame where neither source has the dragged value.
        // (A click with no drag leaves the ref null ⇒ cancel the stray preview.)
        const ov = liveOverrideRef.current;
        liveOverrideRef.current = null;
        if (ov) {
          const patch: OverlayTransformPatch = {};
          // The override rect is in DISPLAY space; map it back to the model rect
          // before diffing/committing (identity for default callers).
          const modelRect = mapCommit(ov.rect);
          if (
            modelRect.x !== overlay.rect.x ||
            modelRect.y !== overlay.rect.y ||
            modelRect.width !== overlay.rect.width ||
            modelRect.height !== overlay.rect.height
          ) {
            patch.rect = modelRect;
          }
          // Rotate commit: the gesture built a transform3d (the single rotation
          // authority) for every overlay; a move/resize leaves `t3d` unset.
          if (ov.t3d) patch.transform3d = ov.t3d;
          if (Object.keys(patch).length > 0) onCommit(patch);
          else editStore.cancelPreview(overlay.id);
        } else {
          editStore.cancelPreview(overlay.id);
        }
        setOverride(null); // drop the local outline; the merged store keeps content
        onFlush?.(overlay.id);
      };

      // Seed the gesture's down coords for move/resize (rotate reads pointer directly).
      if (g.kind === "move") gestureRef.current = { ...g, downX, downY };
      else if (g.kind === "resize") gestureRef.current = { ...g, downX, downY };

      listenersRef.current = { move, up };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [
      locked,
      scale,
      overlay,
      liveRect,
      liveRotation,
      rollDeg,
      composition.width,
      composition.height,
      getCanvasBounds,
      endGesture,
      onCommit,
      onFlush,
      editStore,
      mapCommit,
    ],
  );

  if (canvasDisplayWidth <= 0 || canvasDisplayHeight <= 0) return null;

  // Spatial (out-of-plane / 3D-tilted) overlays don't render at their flat rect.
  // Frame the gizmo on the projected on-screen FOOTPRINT instead, so the box +
  // handles wrap the visible tilted content. The handles still resize/move the
  // underlying rect (the drag math is unchanged) — only WHERE the frame is drawn
  // changes. Planar/identity overlays keep the rect frame + planar rotation.
  // When a displayRect is supplied (the `three` content rect), frame the box on
  // that rect directly — never the projected spatial quad. The flat-quad
  // footprint is meaningless for a `three` viewport (its tilt is camera/scene
  // driven, not a flat-plane transform of the rect).
  // In-plane Spin (rotation.z) is a 2D screen-roll the renderer applies to the
  // composite about the box center — NOT part of the perspective tilt. So the
  // footprint is projected from the OUT-OF-PLANE transform only (`resolvedNoRoll`,
  // a STABLE box as you spin) and the screen-roll is shown by CSS-rotating the
  // whole box (`liveRotation`). This is what stops the gizmo box "going crazy with
  // its sizing" when a tilted code overlay is spun.
  // A `three` overlay renders into an axis-aligned viewport rect; its 3D tilt is
  // camera/scene-driven, NOT a flat-plane transform of the rect, so the spatial
  // quad footprint is meaningless for it (same reasoning as hitTest excluding
  // three from the quad path). Without this, a pitched three whose projected
  // content bounds went degenerate (displayRect undefined) would frame on a
  // foreshortened, ungrabbable quad instead of its full viewport rect.
  const isSpatial =
    !displayRect && overlay.kind !== "three" && classifyTransform(resolvedNoRoll) === "spatial";
  const rawFootprint = isSpatial
    ? projectSpatialQuadFootprint(liveRect, resolvedNoRoll, resolveFlip(overlay))
    : null;
  // The renderer composites the tilt, then rolls it about the RECT center. So
  // roll the tilt footprint polygon about that SAME point and frame the box on
  // the rolled polygon's bbox (no CSS rotate). CSS-rotating the box about its
  // own bbox center — which is NOT the rect center when the tilt footprint is
  // off-center — was the "box goes crazy on every change" pivot mismatch.
  const rectCx = liveRect.x + liveRect.width / 2;
  const rectCy = liveRect.y + liveRect.height / 2;
  const footprintPoly =
    rawFootprint && rawFootprint.polygon.length >= 3
      ? rollRad
        ? rawFootprint.polygon.map((p) => rotatePointAround(p.x, p.y, rectCx, rectCy, rollRad))
        : rawFootprint.polygon
      : null;
  const spatialFramed = !!footprintPoly;
  const displayBox: OverlayRect = spatialFramed
    ? (() => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of footprintPoly!) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      })()
    : liveRect;
  // Quad outline points in box-local CSS px (composition → display scale).
  const polyPoints = spatialFramed
    ? footprintPoly!
        .map((p) => `${(p.x - displayBox.x) * scaleX},${(p.y - displayBox.y) * scaleY}`)
        .join(" ")
    : "";

  const left = displayBox.x * scaleX;
  const top = displayBox.y * scaleY;
  const width = displayBox.width * scaleX;
  const height = displayBox.height * scaleY;

  return (
    <div
      data-testid="overlay-transform-controls"
      data-spatial={spatialFramed ? "true" : "false"}
      className="pointer-events-none absolute left-0 top-0"
      style={{
        left,
        top,
        width,
        height,
        // Planar overlays bake the in-plane roll into the frame here (rotate
        // about the box center = rect center). Spatial overlays must NOT — their
        // footprint polygon is already rolled about the rect center, so a CSS
        // rotate would double-apply about the wrong pivot.
        transform: spatialFramed ? undefined : `rotate(${liveRotation}deg)`,
        transformOrigin: "center center",
        zIndex: 11,
      }}
    >
      {spatialFramed && (
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        >
          <polygon
            points={polyPoints}
            className="fill-primary/5 stroke-primary/70"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        </svg>
      )}
      {/* Bounding box + move body */}
      <div
        data-testid="overlay-move-body"
        onMouseDown={(e) =>
          beginGesture({ kind: "move", startRect: sourceRect, downX: 0, downY: 0 }, e)
        }
        className="absolute inset-0 rounded-sm border-2 border-primary/90"
        style={{
          pointerEvents: locked ? "none" : "auto",
          cursor: locked ? "default" : "move",
        }}
      />
      {/* Rotate handle (above the top edge) */}
      {!locked && (
        <div
          data-testid="overlay-rotate-handle"
          onMouseDown={(e) => beginGesture({ kind: "rotate" }, e)}
          className="absolute left-1/2 size-3 -translate-x-1/2 rounded-full border-2 border-primary bg-background"
          style={{ top: -24, pointerEvents: "auto", cursor: "grab" }}
        />
      )}
      {/* 8 resize handles */}
      {!locked &&
        HANDLES.map((h) => (
          <div
            key={h.id}
            data-testid={`overlay-handle-${h.id}`}
            onMouseDown={(e) =>
              beginGesture(
                {
                  kind: "resize",
                  handle: h.id,
                  startRect: sourceRect,
                  // Seed from the single rotation authority (transform3d roll) so
                  // the resize delta is inverse-rotated by the overlay's spin.
                  rotation: rollDeg,
                  downX: 0,
                  downY: 0,
                },
                e,
              )
            }
            className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-primary bg-background"
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
