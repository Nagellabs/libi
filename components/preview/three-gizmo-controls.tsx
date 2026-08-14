"use client";

import type {
  Composition,
  Overlay,
  OverlayRect,
  TextOverlay,
} from "@/lib/engine/types";
import { mapContentRectToViewport } from "@/lib/engine/three-content-bounds";
import type { OverlayTransformPatch } from "@/hooks/editor/use-overlay-transform-commit";
import { OverlayTransformControls } from "@/components/preview/overlay-transform-controls";
import { OverlayHandles } from "@/components/preview/overlay-handles";

interface ThreeGizmoControlsProps {
  /** Live composition (for frame dims → canvas-relative scale). */
  composition: Composition;
  /** The selected overlay (resolved from the live composition by id). ANY kind
   *  in 3D mode — a `three` overlay, a `place3d` image/video/code overlay, or a
   *  3D text caption (`threeD` set). The gizmo only touches the shared
   *  `BaseOverlay` `rect` (move/resize), so every kind is valid. */
  overlay: Overlay;
  /** Canvas display size in CSS px. */
  canvasDisplayWidth: number;
  canvasDisplayHeight: number;
  /** Whether this overlay is editor-locked (suppresses every gesture). */
  locked?: boolean;
  /** Commit the changed transform LIVE on each move so the painted content
   *  tracks the drag (writes the edit store; debounced background PATCH). */
  onCommit: (patch: OverlayTransformPatch) => void;
  /** Force the debounced PATCH NOW on pointer-up (one PATCH per gesture). */
  onFlush?: (overlayId: string) => void;

  // ── Props threaded down to the composed 2D base-handle layer ──────────────
  /** Canvas element rect provider — for screen→composition mapping (resize/move
   *  + text body-drag). */
  getCanvasBounds?: () => DOMRect | null;
  /** Global snap toggle for the text base-handle layer. Defaults to false. */
  snapEnabled?: boolean;
  /** Sibling text-overlay anchor X positions (composition px) for snap targets. */
  siblingAnchorsX?: number[];
  /** Sibling text-overlay anchor Y positions (composition px) for snap targets. */
  siblingAnchorsY?: number[];
  /** Double-clicking a text overlay body requests the inline text editor. */
  onRequestEdit?: () => void;
  /** For a `three` overlay: the projected CONTENT rect (composition space) the
   *  gizmo box + handles should hug, instead of the full viewport rect. When
   *  undefined (no content bounds, or non-three) the gizmo uses `overlay.rect`. */
  displayRect?: OverlayRect;
}

/**
 * The on-canvas MOVE gizmo for a selected overlay in 3D mode — the base 2D
 * handle layer (move/resize for non-text, corner-font-scale/move for text) plus
 * a small corner "3D" mode label.
 *
 * DEPTH and ROTATION are intentionally NOT on the canvas. Depth (position.z) is
 * the inspector's "Depth (Z)" slider; rotation is the `RotationDialField` (3
 * circles + editable number inputs) inside each overlay's 3D inspector panel.
 * Keeping both off the canvas leaves the on-canvas box unambiguous — its handles
 * only ever move/resize — so there's no orange depth thumb whose effect is
 * unclear. The inspector sliders give precise, labelled control. `locked`
 * suppresses every gesture.
 */
export function ThreeGizmoControls({
  composition,
  overlay,
  canvasDisplayWidth,
  canvasDisplayHeight,
  locked = false,
  onCommit,
  onFlush,
  getCanvasBounds,
  snapEnabled = false,
  siblingAnchorsX = [],
  siblingAnchorsY = [],
  onRequestEdit,
  displayRect,
}: ThreeGizmoControlsProps) {
  const scaleX = composition.width > 0 ? canvasDisplayWidth / composition.width : 1;
  const scaleY = composition.height > 0 ? canvasDisplayHeight / composition.height : 1;

  if (canvasDisplayWidth <= 0 || canvasDisplayHeight <= 0) return null;

  // For a `three` overlay with projected content bounds, position the gizmo box
  // (label, which derives from left/top/width/height) at the content rect so it
  // hugs the visible text. Falls back to the full viewport rect when no
  // displayRect is supplied.
  const boxRect = displayRect ?? overlay.rect;
  const left = boxRect.x * scaleX;
  const top = boxRect.y * scaleY;
  const width = boxRect.width * scaleX;
  const height = boxRect.height * scaleY;

  const isText = overlay.kind === "text";
  const noBounds = getCanvasBounds ?? (() => null);

  return (
    <>
      {/* ── Move base layer: the 2D handles, so move/resize/font-scale all work.
          Renders its OWN absolutely-positioned container over the overlay rect.
          ALWAYS shown — the regular Move control. */}
      {isText ? (
        <OverlayHandles
          composition={composition}
          overlay={overlay as TextOverlay}
          canvasDisplayWidth={canvasDisplayWidth}
          canvasDisplayHeight={canvasDisplayHeight}
          getCanvasBounds={noBounds}
          snapEnabled={snapEnabled}
          locked={locked}
          siblingAnchorsX={siblingAnchorsX}
          siblingAnchorsY={siblingAnchorsY}
          onRequestEdit={onRequestEdit}
          onCommit={onCommit}
          onFlush={onFlush}
        />
      ) : (
        <OverlayTransformControls
          composition={composition}
          overlay={overlay}
          canvasDisplayWidth={canvasDisplayWidth}
          canvasDisplayHeight={canvasDisplayHeight}
          getCanvasBounds={noBounds}
          locked={locked}
          onCommit={onCommit}
          onFlush={onFlush}
          {...(displayRect
            ? {
                displayRect,
                mapRectCommit: (dNew: OverlayRect) =>
                  mapContentRectToViewport(dNew, displayRect, overlay.rect),
              }
            : {})}
        />
      )}

      {/* ── Overlay-anchored corner label. Pointer-events-none so it never blocks
          the base handle layer's clicks. */}
      <div
        data-testid="three-gizmo-controls"
        className="pointer-events-none absolute left-0 top-0"
        style={{ left, top, width, height, zIndex: 13 }}
      >
        {/* Corner LABEL — top-left, never centered, never blocks the content. */}
        <span
          data-testid="gizmo-label"
          className="pointer-events-none absolute left-0 top-0 select-none rounded-br bg-sky-500/85 px-1 py-0.5 text-[9px] font-medium leading-none text-black"
        >
          3D
        </span>
      </div>
    </>
  );
}
