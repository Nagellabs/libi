"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { Composition, TextOverlay, Transform3D } from "@/lib/engine/types";
import type { CaptionAnchor } from "@/lib/captions/types";
import { anchorPointOf } from "@/lib/captions/anchor";
import { composeFont, wrapText } from "@/lib/overlays/caption-style";
import { assembleInkBox, type LineInk, type Rect } from "@/lib/captions/ink-box";
import { resolveOverlayTransform, classifyTransform, resolveFlip } from "@/lib/engine/overlay-transform";
import { cssFamilyForFontFile, withFamily } from "@/lib/fonts/family";
import { screenToCompositionPoint } from "@/components/preview/reanchor-drag-math";
import {
  snapAngle,
  snapPosition1D,
  frameSnapTargetsX,
  frameSnapTargetsY,
  type SnapTarget,
} from "@/lib/captions/snapping";
import type { OverlayTransformPatch } from "@/hooks/editor/use-overlay-transform-commit";
import { SnapGuides, type ActiveGuide } from "@/components/preview/snap-guides";
import { useOverlayEditStore } from "@/lib/preview/overlay-edit-context";
import { textUsesThreeInstance } from "@/lib/overlays/three-d-mode";

/** Minimum point size a corner-scale gesture can shrink to. */
const MIN_FONT_PX = 4;
/** Degrees → radians (transform3d.rotation is radians). */
const DEG_TO_RAD = Math.PI / 180;
/** Positional snap threshold, in COMPOSITION pixels. */
const SNAP_THRESHOLD_COMP = 8;

/**
 * Pure corner-scale math: a uniform fontSize scale equal to the ratio of the
 * dragged diagonal to the original diagonal. Clamped to a sane minimum so a
 * gesture that collapses the box to a point can't write a zero/negative size.
 * Dependency-free + unit-tested (see __tests__/unit/preview/handle-math.test.ts).
 */
export function scaleFontFromCornerDrag(
  oldFont: number,
  oldDiagonalPx: number,
  newDiagonalPx: number,
): number {
  if (!(oldDiagonalPx > 0) || !(newDiagonalPx > 0)) return MIN_FONT_PX;
  const scaled = oldFont * (newDiagonalPx / oldDiagonalPx);
  return Math.max(MIN_FONT_PX, scaled);
}

/** Best-effort px size from a CSS font shorthand (e.g. "700 64px Inter"). */
function parseFontSizePx(font: string): number | null {
  const m = font.match(/(\d+(?:\.\d+)?)px/);
  return m ? parseFloat(m[1]) : null;
}

/** A shared offscreen 2D context for glyph measurement (matches the renderer). */
let scratchCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (scratchCtx) return scratchCtx;
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  scratchCtx = c.getContext("2d");
  return scratchCtx;
}

/** Uniform selection-box padding around the visible ink, proportional to the
 *  font so it reads the same at any caption size. */
function inkPadPx(fontSizePx: number): number {
  return Math.max(6, fontSizePx * 0.1);
}

/**
 * The VISIBLE-ink selection box for a text overlay, in composition pixels.
 *
 * The renderer places glyphs inside the LINE box (`overlay.rect`) with
 * `textBaseline:"top"` — so for ascender-only text the ink hugs the top of the
 * line box and a box drawn at `overlay.rect` looks top-aligned. This measures
 * each wrapped line's real ink extents (same font + wrap as the renderer) and
 * `assembleInkBox` wraps the ink + uniform padding, centering the glyphs in the
 * box. Returns the line box verbatim on the SSR / no-canvas path.
 */
function measureInkRect(overlay: TextOverlay, frameWidth: number): Rect {
  const ctx = getMeasureCtx();
  const composed = composeFont(overlay);
  const fontSizePx = overlay.fontSize ?? parseFontSizePx(composed) ?? 48;
  if (!ctx) return overlay.rect;
  ctx.font = overlay.fontFileId
    ? withFamily(composed, cssFamilyForFontFile(overlay.fontFileId))
    : composed;
  ctx.textBaseline = "top";
  const lineHeightPx = fontSizePx * (overlay.lineHeight ?? 1.2);
  const wrapWidth = overlay.maxWidthPct ? frameWidth * overlay.maxWidthPct : Infinity;
  const wrapped = wrapText((s) => ctx.measureText(s).width, overlay.content, wrapWidth);
  const lines: LineInk[] = wrapped.map((line) => {
    const m = ctx.measureText(line);
    return {
      width: m.width,
      // With textBaseline "top", actualBoundingBoxAscent is NEGATIVE when the
      // ink sits below the draw point, so negate to get a downward offset.
      inkAscentFromTop: -m.actualBoundingBoxAscent,
      inkDescentFromTop: m.actualBoundingBoxDescent,
    };
  });
  return assembleInkBox({
    rect: overlay.rect,
    lines,
    lineHeightPx,
    align: overlay.align,
    padPx: inkPadPx(fontSizePx),
  });
}

/** The four corners as (fx,fy) fractions + the anchor name pinned when that
 *  corner is the FIXED (opposite) one during a scale. */
const CORNERS: { id: string; fx: number; fy: number; cursor: string; oppositeAnchor: CaptionAnchor }[] = [
  { id: "nw", fx: 0, fy: 0, cursor: "nwse-resize", oppositeAnchor: "bottom-right" },
  { id: "ne", fx: 1, fy: 0, cursor: "nesw-resize", oppositeAnchor: "bottom-left" },
  { id: "se", fx: 1, fy: 1, cursor: "nwse-resize", oppositeAnchor: "top-left" },
  { id: "sw", fx: 0, fy: 1, cursor: "nesw-resize", oppositeAnchor: "top-right" },
];

interface OverlayHandlesProps {
  composition: Composition;
  overlay: TextOverlay;
  canvasDisplayWidth: number;
  canvasDisplayHeight: number;
  getCanvasBounds: () => DOMRect | null;
  /** Global snap toggle — when false, all snapping is bypassed. */
  snapEnabled: boolean;
  /** Suppress handles when the overlay is editor-locked. */
  locked?: boolean;
  /** Anchor X positions of sibling text overlays (composition px) for snap targets. */
  siblingAnchorsX: number[];
  siblingAnchorsY: number[];
  /** Double-clicking the body requests entering the inline text editor. */
  onRequestEdit?: () => void;
  /** Commit the changed fields LIVE on each pointer-move so the painted text
   *  tracks the gesture (writes the edit store; debounced background PATCH). */
  onCommit: (patch: OverlayTransformPatch) => void;
  /** Force the debounced PATCH NOW on pointer-up (one PATCH per gesture). */
  onFlush?: (overlayId: string) => void;
}

type Gesture =
  | {
      kind: "corner";
      corner: (typeof CORNERS)[number];
      /** The FIXED pivot of the scale — the box CENTER in composition px. A
       *  corner-drag scales the caption about its center so it stays in the same
       *  coordinate (grows in place) rather than translating toward a held corner. */
      pivot: { x: number; y: number };
      /** The dragged corner's composition point at down. */
      startCorner: { x: number; y: number };
      startFont: number;
      /** Distance from the dragged corner to the center at down (scale baseline). */
      startDiag: number;
    }
  | { kind: "rotate"; centerComp: { x: number; y: number } }
  | {
      kind: "body";
      startPos: { x: number; y: number };
      anchor: CaptionAnchor;
      downComp: { x: number; y: number };
    };

/**
 * Point-text direct-manipulation handles. Renders over the MEASURED glyph box
 * (not the stored rect): 4 corner handles (uniform fontSize scale, opposite
 * corner held fixed), a rotate handle (planar z degrees, snapped to 15° detents
 * unless Alt held), and a body-drag surface (moves `position`, each axis snapped
 * to frame guides + sibling anchors unless Alt held). All commits go through the
 * standard PATCH path via `onCommit`.
 *
 * Corner-scale approach: because the box is DERIVED from glyphs, we keep the
 * opposite corner visually fixed by re-pinning the overlay to that corner — we
 * set `anchor` to the opposite corner's 9-point name and `position` to that
 * corner's composition point, then write the new `fontSize`. The box then grows
 * away from the held corner exactly like CapCut.
 */
export function OverlayHandles({
  composition,
  overlay,
  canvasDisplayWidth,
  canvasDisplayHeight,
  getCanvasBounds,
  snapEnabled,
  locked = false,
  siblingAnchorsX,
  siblingAnchorsY,
  onRequestEdit,
  onCommit,
  onFlush,
}: OverlayHandlesProps) {
  const scaleX = composition.width > 0 ? canvasDisplayWidth / composition.width : 1;
  const scaleY = composition.height > 0 ? canvasDisplayHeight / composition.height : 1;
  // Inline edit store: per-move we write the in-flight text patch
  // (position/anchor/fontSize) as a PREVIEW (NO commit → NO React recomposite);
  // the canvas re-measures + repaints via the store's imperative channel.
  const editStore = useOverlayEditStore();

  // Local optimistic override during a gesture; null ⇒ render from `overlay`.
  const [override, setOverride] = useState<{
    rect: { x: number; y: number; width: number; height: number };
    rotation: number;
  } | null>(null);
  const [activeGuides, setActiveGuides] = useState<ActiveGuide[]>([]);
  const gestureRef = useRef<Gesture | null>(null);
  const listenersRef = useRef<{ move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null>(
    null,
  );

  // Two rects, deliberately distinct:
  //  • `baseRect` = the overlay's authored LINE box (`overlay.rect`) — the exact
  //    geometry the renderer places glyphs within and what every PATCH writes.
  //    ALL gesture math (corner-scale pivot, body-translate, commit) runs on it.
  //  • `inkRect` = the VISIBLE-ink box + uniform padding — what the selection box
  //    DISPLAYS, so the glyphs sit centered in the box. The line box has empty
  //    descender/leading space at the bottom for ascender-only text, which read
  //    as a top-aligned box; the ink box wraps the actual letters instead.
  // During a gesture, `override.rect` holds the live INK display rect while the
  // line rect rides separately on the gesture (`_rect`) into the patch/commit.
  const baseRect = overlay.rect;
  // 3D-mode text (place3d / threeD) renders through the three instance into the
  // `overlay.rect` viewport (window model) — fit + centered + rolled about the
  // RECT center — exactly like a `three` overlay. So its selection box must be
  // `overlay.rect` with a rect-center pivot, NOT the flat-text ink box (which is
  // measured from 2D glyph metrics that don't describe where the 3D text lands).
  // Using the ink box was the "t" sticks out + rotation-desync bug. Flat (2D)
  // text is unchanged — it keeps the ink box.
  const is3d = textUsesThreeInstance(overlay);
  const inkRect = useMemo<Rect>(
    () => (is3d ? baseRect : measureInkRect(overlay, composition.width)),
    [is3d, baseRect, overlay, composition.width],
  );
  const liveRect = override?.rect ?? inkRect;
  // The overlay's resolved orientation (transform3d, or synthesized from the
  // legacy rotation/flip fields). PLANAR (scale/z-rot/2D-translate) mirrors onto
  // the box; SPATIAL (true-3D) keeps the box axis-aligned (known limitation).
  const resolvedT = resolveOverlayTransform(overlay);
  const planarT = classifyTransform(resolvedT) !== "spatial";
  const RAD_TO_DEG = 180 / Math.PI;
  // 3D text: the renderer applies position + tilt (x/y) INSIDE the GL viewport and
  // rolls the composite by rotation.z about the rect center. So the box reflects
  // ONLY the z-roll (the Spin) — like `three` — regardless of tilt. The in-plane
  // roll is always transform3d.rotation.z (the single rotation authority), so the
  // box's rest angle reads from it for every case (planar, spatial, and 3D text).
  const restRotDeg = resolvedT.rotation.z * RAD_TO_DEG;
  // The z-rotation the box currently shows — the live gesture angle while
  // dragging, else the overlay's resolved planar rotation.
  const liveRotation = override?.rotation ?? restRotDeg;

  const snapTargetsX = useMemo<SnapTarget[]>(
    () => frameSnapTargetsX(composition.width, siblingAnchorsX),
    [composition.width, siblingAnchorsX],
  );
  const snapTargetsY = useMemo<SnapTarget[]>(
    () => frameSnapTargetsY(composition.height, siblingAnchorsY),
    [composition.height, siblingAnchorsY],
  );

  const endGesture = useCallback(() => {
    const l = listenersRef.current;
    if (l) {
      window.removeEventListener("mousemove", l.move);
      window.removeEventListener("mouseup", l.up);
      listenersRef.current = null;
    }
    gestureRef.current = null;
    setActiveGuides([]);
  }, []);

  const beginGesture = useCallback(
    (g: Gesture, e: React.MouseEvent) => {
      if (locked) return;
      e.preventDefault();
      e.stopPropagation();
      gestureRef.current = g;

      const move = (ev: MouseEvent) => {
        const cur = gestureRef.current;
        if (!cur) return;
        const bounds = getCanvasBounds();
        if (!bounds) return;
        const pt = screenToCompositionPoint(ev, bounds, composition.width, composition.height);
        const alt = ev.altKey;
        const bypass = alt || !snapEnabled;

        if (cur.kind === "corner") {
          // Scale about the box CENTER (`pivot`), not the opposite corner — the
          // caption grows in place and keeps its coordinate instead of sliding
          // toward a held corner. Magnitude tracks the dragged corner's distance
          // from center, so the grabbed handle follows the cursor.
          const newDiag = Math.hypot(pt.x - cur.pivot.x, pt.y - cur.pivot.y);
          const nextFont = scaleFontFromCornerDrag(cur.startFont, cur.startDiag, newDiag);
          const ratio = cur.startDiag > 0 ? newDiag / cur.startDiag : 1;
          // LINE rect — centered on the pivot, scaled by `ratio`. Drives the
          // renderer patch + commit (the renderer places glyphs within this rect).
          const lineW = baseRect.width * ratio;
          const lineH = baseRect.height * ratio;
          const lineNew = {
            x: cur.pivot.x - lineW / 2,
            y: cur.pivot.y - lineH / 2,
            width: lineW,
            height: lineH,
          };
          // The live patch the renderer paints THIS frame: pin the caption's
          // CENTER to the pivot + write the new font size + line rect. This is the
          // SAME patch `up` commits, so the box hands off without a jump.
          const livePatch = {
            rect: lineNew,
            fontSize: Math.round(nextFont * 100) / 100,
            anchor: "mid-center" as CaptionAnchor,
            position: { x: cur.pivot.x, y: cur.pivot.y },
          };
          // INK display box — RE-MEASURE the actual live text (same font + line
          // rect the renderer draws this frame) instead of geometrically scaling
          // the resting ink box. A scaled box drifts from the re-rendered glyphs
          // (font metrics aren't perfectly linear), so the text escaped the box
          // mid-resize then snapped back on release. Re-measuring keeps the box
          // wrapping the glyphs continuously, and the release recomputes the same
          // value → no snap.
          // Flat text shows the re-measured INK box (glyphs wrap continuously).
          // 3D text shows the LINE rect itself — the renderer fits the text into
          // that rect viewport, so the box == the rect being dragged (no flat-ink
          // measurement, which doesn't describe 3D text).
          const inkLive = is3d
            ? lineNew
            : measureInkRect({ ...overlay, ...livePatch } as TextOverlay, composition.width);
          setOverride({ rect: inkLive, rotation: liveRotation });
          // Stash the font + LINE rect on the gesture so `up` commits the SAME
          // line rect the drag drew.
          (cur as { _font?: number })._font = nextFont;
          (cur as { _rect?: { x: number; y: number; width: number; height: number } })._rect =
            lineNew;
          // Paint the resized text this frame via the edit store's PREVIEW
          // channel (no commit, no React recomposite).
          editStore.preview(overlay.id, livePatch);
        } else if (cur.kind === "rotate") {
          const deg = (Math.atan2(pt.y - cur.centerComp.y, pt.x - cur.centerComp.x) * 180) / Math.PI + 90;
          const snapped = snapAngle(deg, { bypass });
          setOverride({ rect: liveRect, rotation: snapped });
          // Write the in-plane spin onto transform3d.rotation.z — the SINGLE
          // rotation authority (there is no legacy `rotation` field). Build off
          // the resting transform so position/scale/3D angles are
          // preserved; stash it so `up` commits the SAME value synchronously.
          const base = resolveOverlayTransform(overlay);
          const t3d: Transform3D = {
            ...base,
            rotation: { ...base.rotation, z: snapped * DEG_TO_RAD },
          };
          (cur as { _t3d?: Transform3D })._t3d = t3d;
          editStore.preview(overlay.id, { transform3d: t3d });
        } else {
          // body drag — translate position by the composition-space delta.
          const dx = pt.x - cur.downComp.x;
          const dy = pt.y - cur.downComp.y;
          let nx = cur.startPos.x + dx;
          let ny = cur.startPos.y + dy;
          const guides: ActiveGuide[] = [];
          if (!bypass) {
            const sx = snapPosition1D(nx, snapTargetsX, SNAP_THRESHOLD_COMP);
            const sy = snapPosition1D(ny, snapTargetsY, SNAP_THRESHOLD_COMP);
            nx = sx.value;
            ny = sy.value;
            if (sx.hit) guides.push({ axis: "x", value: sx.value, kind: sx.hit.kind });
            if (sy.hit) guides.push({ axis: "y", value: sy.value, kind: sy.hit.kind });
          }
          setActiveGuides(guides);
          const dxR = nx - cur.startPos.x;
          const dyR = ny - cur.startPos.y;
          // INK display rect — translate the visible-ink box so the selection box
          // tracks the glyphs under the cursor (display only).
          setOverride({
            rect: {
              x: inkRect.x + dxR,
              y: inkRect.y + dyR,
              width: inkRect.width,
              height: inkRect.height,
            },
            rotation: liveRotation,
          });
          (cur as { _pos?: { x: number; y: number } })._pos = { x: nx, y: ny };
          // LINE rect — translate `overlay.rect` by the SAME delta. This is what
          // the renderer places glyphs within and what `up` commits, so the box
          // and glyphs move in lockstep with no release jump.
          const movedLineRect = {
            x: baseRect.x + dxR,
            y: baseRect.y + dyR,
            width: baseRect.width,
            height: baseRect.height,
          };
          (cur as { _rect?: { x: number; y: number; width: number; height: number } })._rect =
            movedLineRect;
          // Paint the moved text this frame via the edit store's PREVIEW
          // channel. The renderer places glyphs from `overlay.rect` (NOT
          // position), so the live patch MUST carry the translated LINE rect —
          // or only the box moves and the text stays put.
          editStore.preview(overlay.id, {
            rect: movedLineRect,
            position: { x: nx, y: ny },
            anchor: cur.anchor,
          });
        }
      };

      const up = () => {
        const cur = gestureRef.current;
        endGesture();
        if (!cur) {
          // A click that never moved: drop the local outline and any stray
          // preview entry (no-ops if none).
          setOverride(null);
          editStore.cancelPreview(overlay.id);
          return;
        }
        // The last pointer-move painted the live value via the edit store's
        // PREVIEW channel. Build the final diff, COMMIT it to the edit store
        // (one React render — flips the preview entry to committed), then
        // `flush` to persist exactly ONE coalesced PATCH for the gesture.
        const patch: OverlayTransformPatch = {};
        if (cur.kind === "corner") {
          const nextFont = (cur as { _font?: number })._font;
          if (nextFont !== undefined && nextFont !== (overlay.fontSize ?? -1)) {
            patch.fontSize = Math.round(nextFont * 100) / 100;
          }
          // Pin the caption's CENTER to the scale pivot so it keeps its
          // coordinate (grows in place) rather than sliding toward a held corner.
          patch.anchor = "mid-center";
          patch.position = { x: cur.pivot.x, y: cur.pivot.y };
        } else if (cur.kind === "rotate") {
          // Commit the transform3d the last move built (the in-plane spin) — same
          // commit-before-flush shape as the corner/body branches. No side
          // effects inside a setOverride updater.
          const t3d = (cur as { _t3d?: Transform3D })._t3d;
          if (t3d) patch.transform3d = t3d;
        } else {
          const pos = (cur as { _pos?: { x: number; y: number } })._pos;
          if (pos && (pos.x !== cur.startPos.x || pos.y !== cur.startPos.y)) {
            patch.position = { x: pos.x, y: pos.y };
            patch.anchor = cur.anchor;
          }
        }
        // Commit the SAME final rect the drag/resize showed (body + corner stash
        // it). This makes the edit-store merge authoritative with the dragged
        // rect the instant the live drag clears — no snap-back-then-jump on
        // release. (Rotate leaves `_rect` unset; it only patches rotation.)
        const finalRect = (cur as { _rect?: { x: number; y: number; width: number; height: number } })
          ._rect;
        if (finalRect) patch.rect = finalRect;
        setOverride(null);
        // Commit flips the preview entry to committed (one React render) and the
        // committed patch keeps painting until the PATCH lands + `confirm` drops
        // it — no frame can show the origin. If the gesture produced an empty
        // diff (a pure click), cancel the stray preview instead.
        if (Object.keys(patch).length > 0) onCommit(patch);
        else editStore.cancelPreview(overlay.id);
        onFlush?.(overlay.id);
      };

      listenersRef.current = { move, up };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [
      locked,
      getCanvasBounds,
      composition.width,
      composition.height,
      snapEnabled,
      baseRect,
      inkRect,
      liveRect,
      liveRotation,
      snapTargetsX,
      snapTargetsY,
      is3d,
      // The whole overlay, not cherry-picked fields: the rotate gesture calls
      // resolveOverlayTransform(overlay) off the resting transform, so any
      // stale slice here would let a prior position/scale edit be clobbered
      // by the next rotate.
      overlay,
      endGesture,
      onCommit,
      onFlush,
      editStore,
    ],
  );

  if (canvasDisplayWidth <= 0 || canvasDisplayHeight <= 0) return null;

  const left = liveRect.x * scaleX;
  const top = liveRect.y * scaleY;
  const width = liveRect.width * scaleX;
  const height = liveRect.height * scaleY;

  // ── Mirror the overlay's PLANAR transform onto the box so a transformed
  // caption shows a matching box. The renderer applies the planar transform
  // about the LINE-rect center via `translate(c+pos)·rotate(z)·scale·translate(-c)`;
  // CSS `transform-origin` at that center reproduces it exactly. The origin
  // (relative to the box) is computed from the RESTING line center + resting ink
  // rect, which makes it invariant under body-drag translation (the box's
  // left/top already moves). `liveRotation` carries the live gesture angle.
  const flip = resolveFlip(overlay);
  const boxScaleX = flip.flipH ? -1 : 1;
  const boxScaleY = flip.flipV ? -1 : 1;
  // 3D text: position (incl. depth) lives INSIDE the GL viewport, never as a 2D
  // box translate; and the box (= overlay.rect) rolls about its OWN center, which
  // is the rect center the renderer rolls about. Flat text keeps the line-center
  // pivot relative to the ink box.
  const boxTransX = (planarT && !is3d ? resolvedT.position.x : 0) * scaleX;
  const boxTransY = (planarT && !is3d ? resolvedT.position.y : 0) * scaleY;
  const lineCx = baseRect.x + baseRect.width / 2;
  const lineCy = baseRect.y + baseRect.height / 2;
  const boxOriginX = is3d ? width / 2 : (lineCx - inkRect.x) * scaleX;
  const boxOriginY = is3d ? height / 2 : (lineCy - inkRect.y) * scaleY;
  const boxTransform = `translate(${boxTransX}px, ${boxTransY}px) rotate(${liveRotation}deg) scale(${boxScaleX}, ${boxScaleY})`;

  const anchor: CaptionAnchor = overlay.anchor ?? "mid-center";
  const startPosForBody = overlay.position ?? anchorPointOf(overlay.rect, anchor);

  return (
    <>
      <SnapGuides
        guides={activeGuides}
        composition={composition}
        canvasDisplayWidth={canvasDisplayWidth}
        canvasDisplayHeight={canvasDisplayHeight}
      />
      <div
        data-testid="overlay-handles"
        className="pointer-events-none absolute left-0 top-0"
        style={{
          left,
          top,
          width,
          height,
          transform: boxTransform,
          transformOrigin: `${boxOriginX}px ${boxOriginY}px`,
          zIndex: 12,
        }}
      >
        {/* Body drag surface */}
        <div
          data-testid="overlay-handles-body"
          onDoubleClick={() => onRequestEdit?.()}
          onMouseDown={(e) =>
            beginGesture(
              {
                kind: "body",
                startPos: startPosForBody,
                anchor,
                downComp: (() => {
                  const b = getCanvasBounds();
                  return b
                    ? screenToCompositionPoint(e, b, composition.width, composition.height)
                    : { x: 0, y: 0 };
                })(),
              },
              e,
            )
          }
          className="absolute inset-0 rounded-sm border-2 border-primary/90"
          style={{
            pointerEvents: locked ? "none" : "auto",
            cursor: locked ? "default" : "move",
          }}
        />
        {/* Rotate handle */}
        {!locked && (
          <div
            data-testid="overlay-handles-rotate"
            onMouseDown={(e) =>
              beginGesture(
                {
                  kind: "rotate",
                  centerComp: {
                    x: liveRect.x + liveRect.width / 2,
                    y: liveRect.y + liveRect.height / 2,
                  },
                },
                e,
              )
            }
            className="absolute left-1/2 size-3 -translate-x-1/2 rounded-full border-2 border-primary bg-background"
            style={{ top: -24, pointerEvents: "auto", cursor: "grab" }}
          />
        )}
        {/* 4 corner handles */}
        {!locked &&
          CORNERS.map((c) => (
            <div
              key={c.id}
              data-testid={`overlay-handles-corner-${c.id}`}
              onMouseDown={(e) => {
                const fx = c.fx;
                const fy = c.fy;
                // Scale about the box CENTER so the caption grows in place.
                const pivot = {
                  x: baseRect.x + baseRect.width / 2,
                  y: baseRect.y + baseRect.height / 2,
                };
                const startCorner = {
                  x: baseRect.x + fx * baseRect.width,
                  y: baseRect.y + fy * baseRect.height,
                };
                const startDiag = Math.hypot(
                  startCorner.x - pivot.x,
                  startCorner.y - pivot.y,
                );
                const composed = composeFont(overlay);
                const startFont = overlay.fontSize ?? parseFontSizePx(composed) ?? 48;
                beginGesture(
                  { kind: "corner", corner: c, pivot, startCorner, startFont, startDiag },
                  e,
                );
              }}
              className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-primary bg-background"
              style={{
                left: `${c.fx * 100}%`,
                top: `${c.fy * 100}%`,
                pointerEvents: "auto",
                cursor: c.cursor,
              }}
            />
          ))}
      </div>
    </>
  );
}
