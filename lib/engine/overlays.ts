import type { Composition, Overlay, OverlayRect, Transform3D } from "./types";
import type { Track } from "@/lib/tracking/types";
import { sampleTrackedOverlay } from "@/lib/engine/tracked-space";
import { resolveTrackedRect } from "./overlay-renderer";
import { resolveOverlayTransform, resolveFlip, classifyTransform, inversePlanarPoint, splitScreenRoll, rotatePointAround } from "@/lib/engine/overlay-transform";
import { projectSpatialQuadFootprint, pointInQuad } from "@/lib/engine/overlay-quad-projection";
import { textUsesThreeInstance } from "@/lib/overlays/three-d-mode";

/**
 * Clamp a 2D overlay rect to the composition frame so it can't sit (partly)
 * off-frame. Caps width/height to the frame, then shifts x/y so the rect stays
 * visible. 3D `three` overlays are NOT clamped here —
 * their projected size depends on the camera (see the render-verify loop).
 * No-ops when frame dims are missing/zero.
 *
 * A box SMALLER than the frame is kept fully inside [0,frameW]×[0,frameH].
 * A box AS LARGE AS / LARGER THAN the frame (the common `three` default rect,
 * which fills the canvas) can be positioned freely as long as it stays at least
 * partly on screen — the user dragging X/Y on a full-frame overlay must STICK.
 * The old `[0, frameW-width]` range collapsed to `0` once `width === frameW`,
 * which silently reverted every X/Y drag on a full-frame overlay back to the
 * origin. `clamp1D` derives a valid `[lo,hi]` range for both cases.
 */
export function clampRectToFrame(rect: OverlayRect, frameW: number, frameH: number): OverlayRect {
  if (!frameW || !frameH) return rect;
  // Cap size to the frame so a box can never be larger than the canvas.
  const width = Math.max(1, Math.min(rect.width, frameW));
  const height = Math.max(1, Math.min(rect.height, frameH));
  return {
    x: clamp1D(rect.x, width, frameW),
    y: clamp1D(rect.y, height, frameH),
    width,
    height,
  };
}

/**
 * Clamp one axis of a rect origin so the box stays at least partly on screen.
 * - `size < frame` (box fits): origin ∈ [0, frame-size] → fully inside.
 * - `size === frame` (box fills the canvas — the common `three` default rect):
 *   origin can range ±(frame-size of visibility margin) so the user's X/Y drag
 *   STICKS instead of snapping back to 0. The old `[0, frame-size]` range
 *   collapsed to a single `0` here, silently reverting every full-frame drag.
 *
 * A frame-filling box is allowed to slide until only `VISIBLE_MARGIN_PX` of it
 * remains on screen, matching how direct-manipulation drag in the preview lets
 * an overlay run off the edge without vanishing.
 */
const VISIBLE_MARGIN_PX = 16;
function clamp1D(origin: number, size: number, frame: number): number {
  // Slack is how far the origin may travel while keeping the box fully inside.
  const fitSlack = frame - size;
  if (fitSlack > 0) {
    // Box fits: keep it fully inside [0, fitSlack].
    return Math.min(Math.max(origin, 0), fitSlack);
  }
  // Box fills (or, post-cap, equals) the frame: allow it to slide off either
  // edge but keep at least VISIBLE_MARGIN_PX (or the whole box, if tiny) shown.
  const margin = Math.min(VISIBLE_MARGIN_PX, size);
  const lo = margin - size; // left/top edge may go this far negative
  const hi = frame - margin; // right/bottom may extend this far past origin 0
  return Math.min(Math.max(origin, lo), hi);
}

/** Active = inside the time window AND not hidden. Hidden overlays
 *  (`o.hidden === true`, the persisted eye toggle) are never active — this is
 *  the single render/hit-test chokepoint enforcing "layer OFF everywhere"
 *  (renderFrame, collectVideoSeekTargets, hitTest, the chromium /render page,
 *  and canvas-source export all route through here). */
export function overlaysActiveAt(overlays: Overlay[], time: number): Overlay[] {
  const active = overlays.filter(
    (o) =>
      o.hidden !== true && o.duration > 0 && time >= o.startTime && time < o.startTime + o.duration,
  );
  return active.sort((a, b) => a.z - b.z);
}

/**
 * Inverse-transform a test point into a box's LOCAL (untransformed) space so
 * an axis-aligned containment test works on a rotated/flipped overlay. Undo
 * order is the inverse of the renderer's apply order: translate point to box
 * center, undo flip (mirror), undo rotation (rotate by -rad), translate back.
 * Returns the point unchanged when the transform is identity.
 */
function inverseTransformPoint(
  px: number,
  py: number,
  box: { x: number; y: number; width: number; height: number },
  o: { transform3d?: Transform3D; rotation?: number; flipH?: boolean; flipV?: boolean },
): { x: number; y: number } {
  const t = resolveOverlayTransform(o);
  // spatial transforms have no cheap 2D inverse — caller uses the rect directly.
  if (classifyTransform(t) === "spatial") return { x: px, y: py };
  return inversePlanarPoint(t, box, resolveFlip(o), px, py);
}

/**
 * Return the topmost overlay whose hit region contains (x, y) at the given
 * time, or null. Higher z wins.
 * For `kind:"tracked"` the hit region is the LIVE `resolveTrackedRect` art
 * box (applyFitAndScale + the follow offset; requires `tracks`); all other
 * kinds use `overlay.rect`.
 * Callers SHOULD pass `frame` (composition width/height) so the tracked
 * hit box matches the renderer's clampToFrame behavior; without it an
 * oversized detection's hit region can exceed the visibly-rendered art.
 * For `kind:"three"` callers MAY pass `threeContentRects` (overlayId → the
 * composition-space rect where the 3D content actually projects) so clicking
 * the visible text — not the empty viewport — selects the overlay; absent an
 * entry the full `overlay.rect` is used.
 */
export function hitTest(
  x: number,
  y: number,
  overlays: Overlay[],
  time: number,
  tracks?: Record<string, Track>,
  frame?: { width: number; height: number },
  threeContentRects?: Record<string, OverlayRect>,
): Overlay | null {
  const active = overlaysActiveAt(overlays, time);
  // Highest z first — iterate reversed.
  for (let i = active.length - 1; i >= 0; i--) {
    const o = active[i];
    let box: { x: number; y: number; width: number; height: number } | null = null;
    if (o.kind === "tracked") {
      const tr = tracks?.[o.trackId];
      if (!tr) continue;
      // Sampled on the owning video's clock and mapped into composition
      // pixels — the hit region has to be where the art actually IS, so this
      // must be the same call the renderer makes (lib/engine/tracked-space.ts).
      const s = sampleTrackedOverlay(o, tr, overlays, time);
      if (!s || !s.visible) continue;
      const a = resolveTrackedRect(s, o, frame);
      box = { x: a.x, y: a.y, width: a.w, height: a.h };
    } else if (o.kind === "three") {
      // Use the projected content rect (where the 3D text actually lands) when
      // the preview computed one; else fall back to the full viewport rect.
      box = threeContentRects?.[o.id] ?? o.rect;
    } else {
      box = o.rect;
    }
    // Spatial (out-of-plane) overlays render through the textured quad, so the
    // flat rect doesn't describe where they land. Hit-test against the projected
    // on-screen footprint polygon instead. (Tracked overlays only apply the
    // planar transform, so they keep the rect path.) `three` overlays are also
    // excluded: their transform3d moves content INSIDE a fixed axis-aligned rect
    // viewport, never the rect on canvas — so the rect test (not the skewed quad)
    // is what selects them. 3D-mode TEXT renders through the three instance into
    // that same rect viewport (window model), so it's excluded for the same reason
    // — matching the gizmo box (see overlay-transform-controls.tsx isSpatial).
    if (o.kind !== "tracked" && o.kind !== "three" && !textUsesThreeInstance(o)) {
      const t = resolveOverlayTransform(o);
      if (classifyTransform(t) === "spatial") {
        // The footprint is projected from the OUT-OF-PLANE transform only; the
        // in-plane Spin (rotation.z) is a 2D screen-roll applied to the composite
        // about the box center. Undo that roll on the test point, then test the
        // (stable) tilt footprint — matching how the renderer composites.
        const { spatial, rollRad } = splitScreenRoll(t);
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const p = rollRad ? rotatePointAround(x, y, cx, cy, -rollRad) : { x, y };
        const fp = projectSpatialQuadFootprint(box, spatial, resolveFlip(o));
        if (fp.polygon.length >= 3 && pointInQuad(p, fp.polygon)) return o;
        continue;
      }
    }
    const local = inverseTransformPoint(x, y, box, o);
    if (
      local.x >= box.x &&
      local.x < box.x + box.width &&
      local.y >= box.y &&
      local.y < box.y + box.height
    ) {
      return o;
    }
  }
  return null;
}

// -----------------------------------------------------------------
// IN-MEMORY helpers (for the renderer + hit-test + tests)
// NOT persistence — see lib/composition/persistence.ts for the
// manifest-level CRUD (addOverlayToManifest / updateOverlayInManifest /
// removeOverlayFromManifest / reorderOverlaysInManifest).
// -----------------------------------------------------------------

export function addOverlay(comp: Composition, overlay: Overlay): Composition {
  return { ...comp, overlays: [...(comp.overlays ?? []), overlay] };
}

export function updateOverlay(
  comp: Composition,
  id: string,
  patch: Partial<Overlay>,
): Composition {
  const overlays = (comp.overlays ?? []).map((o) =>
    o.id === id ? ({ ...o, ...patch } as Overlay) : o,
  );
  return { ...comp, overlays };
}

export function removeOverlay(comp: Composition, id: string): Composition {
  return { ...comp, overlays: (comp.overlays ?? []).filter((o) => o.id !== id) };
}
