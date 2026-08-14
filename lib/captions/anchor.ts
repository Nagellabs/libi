// lib/captions/anchor.ts
import type { CaptionAnchor, Caption3DLook } from "@/lib/captions/types";
import type { OverlayRect } from "@/lib/engine/types";

/** Place a rect of (w,h) at a 3×3 anchor inside the frame, with a safe margin. */
export function anchorToRect(
  anchor: CaptionAnchor,
  frame: { width: number; height: number },
  size: { width: number; height: number },
  margin = 0.06,
): OverlayRect {
  const mx = frame.width * margin;
  const my = frame.height * margin;
  const [v, h] = anchor.split("-") as ["top" | "mid" | "bottom", "left" | "center" | "right"];
  const x = h === "left" ? mx : h === "right" ? frame.width - size.width - mx : (frame.width - size.width) / 2;
  const y = v === "top" ? my : v === "bottom" ? frame.height - size.height - my : (frame.height - size.height) / 2;
  return { x, y, width: size.width, height: size.height };
}

/**
 * The canvas point where a non-text overlay's CONTENT CENTER should sit for a
 * 3×3 region — content-aware so "top" reads as top and "left" as left for ANY
 * box size, including a frame-filling `three`/`code` overlay.
 *
 * Per axis:
 *  - **Box fits the frame** (e.g. an image): hug the named edge (margin inset).
 *    The returned center equals `anchorToRect`'s center, so placing the box
 *    centered on this point is identical to the old edge-anchor — image/video
 *    are unaffected.
 *  - **Box overflows the frame** (a frame-sized `three`/`code` box): place the
 *    content center at ¼ / ½ / ¾ of the frame toward the region. This fixes the
 *    inversion where corner-anchoring a frame-sized box pushed the content the
 *    OPPOSITE way (anchor "top-left" → content shifted DOWN-RIGHT by the margin).
 *
 * Used by the inspector anchor pad for non-text kinds; text keeps `anchorToRect`
 * (its box always wraps the glyphs, so edge-anchoring already reads correctly).
 */
export function regionCenterPoint(
  anchor: CaptionAnchor,
  frame: { width: number; height: number },
  size: { width: number; height: number },
  margin = 0.06,
): { x: number; y: number } {
  const place1d = (side: "near" | "center" | "far", frameLen: number, boxLen: number): number => {
    if (boxLen >= frameLen) {
      // Overflow → center-on-region so the direction is intuitive.
      const frac = side === "near" ? 0.25 : side === "far" ? 0.75 : 0.5;
      return frameLen * frac;
    }
    // Fits → hug the edge (center = margin + half box), matching anchorToRect.
    const m = frameLen * margin;
    return side === "near" ? m + boxLen / 2 : side === "far" ? frameLen - m - boxLen / 2 : frameLen / 2;
  };
  const [v, h] = anchor.split("-") as ["top" | "mid" | "bottom", "left" | "center" | "right"];
  return {
    x: place1d(h === "left" ? "near" : h === "right" ? "far" : "center", frame.width, size.width),
    y: place1d(v === "top" ? "near" : v === "bottom" ? "far" : "center", frame.height, size.height),
  };
}

/** Fractional (fx,fy) of the box the anchor names: left/center/right → 0/.5/1,
 *  top/mid/bottom → 0/.5/1. */
export function anchorFraction(a: CaptionAnchor): { fx: number; fy: number } {
  const [v, h] = a.split("-") as ["top" | "mid" | "bottom", "left" | "center" | "right"];
  const fx = h === "left" ? 0 : h === "right" ? 1 : 0.5;
  const fy = v === "top" ? 0 : v === "bottom" ? 1 : 0.5;
  return { fx, fy };
}

/** The canvas point where `anchor` currently sits for a given rect (inverse of placeBoxAtAnchor). */
export function anchorPointOf(
  rect: { x: number; y: number; width: number; height: number },
  anchor: CaptionAnchor,
): { x: number; y: number } {
  const { fx, fy } = anchorFraction(anchor);
  return { x: rect.x + fx * rect.width, y: rect.y + fy * rect.height };
}

/** Place a box of (w,h) so its `anchor` point sits at `position`. Returns top-left rect. */
export function placeBoxAtAnchor(
  position: { x: number; y: number },
  anchor: CaptionAnchor,
  w: number,
  h: number,
): { x: number; y: number; width: number; height: number } {
  const { fx, fy } = anchorFraction(anchor);
  return { x: position.x - fx * w, y: position.y - fy * h, width: w, height: h };
}

/** Map a 3D-look preset to the renderer's tilt preset name (or null for flat). */
export function look3dToTilt(look: Caption3DLook): "billboard" | "ground" | "lowAngle" | "highAngle" | "angled" | null {
  switch (look) {
    case "flat": return null;
    case "billboard": return "billboard";
    case "lay-on-road": return "ground";
    case "low-angle": return "lowAngle";
    case "angled": return "angled";
  }
}
