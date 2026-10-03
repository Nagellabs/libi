/**
 * Keyframed rects that travel with their overlay.
 *
 * A rect keyframe track holds ABSOLUTE rects, and while a track exists the
 * renderer reads it instead of the overlay's base `rect` (lib/engine/animatable
 * `valueAt(keyframes.rect ?? rect)`). So moving or resizing the base rect alone
 * changes nothing visible, and the animation stays pinned to the old layout.
 * `followRectKeyframes` carries each keyframe along with the base: it keeps its
 * offset from the base's top-left (scaled when the base was resized) and its
 * size ratio. Pure, no IO; used by `libi.update_overlay` and by template reflow
 * (lib/templates/reflow.ts).
 */
import type { OverlayKeyframes, OverlayRect, Transform3D } from "@/lib/engine/types";

const round = (n: number): number => Math.round(n * 100) / 100;

/** `rect` moved from the frame of `from` into the frame of `to`: same offset from the
 *  base's top-left, scaled by how much the base grew or shrank on each axis. */
export function followRect(rect: OverlayRect, from: OverlayRect, to: OverlayRect): OverlayRect {
  const fx = from.width > 0 ? to.width / from.width : 1;
  const fy = from.height > 0 ? to.height / from.height : 1;
  return {
    x: round(to.x + (rect.x - from.x) * fx),
    y: round(to.y + (rect.y - from.y) * fy),
    width: round(rect.width * fx),
    height: round(rect.height * fy),
  };
}

/** Whether two rects are the same box (so there is nothing to follow). */
export function sameRect(a: OverlayRect, b: OverlayRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * The keyframes with their rect track moved from the base `from` to the base `to`. Opacity and
 * transform3d tracks are untouched. Returns the SAME object when there is nothing to do (no rect
 * track, or the base did not change), so a caller can tell by identity.
 */
export function followRectKeyframes(
  keyframes: OverlayKeyframes | undefined,
  from: OverlayRect,
  to: OverlayRect,
): OverlayKeyframes | undefined {
  const track = keyframes?.rect;
  if (!keyframes || !track || track.keyframes.length === 0 || sameRect(from, to)) return keyframes;
  return {
    ...keyframes,
    rect: { keyframes: track.keyframes.map((k) => ({ ...k, value: followRect(k.value, from, to) })) },
  };
}

/** A 3D transform with its x/y translation (composition pixels from the rect centre) multiplied by `k`. */
export function scaleTransformOffset(t: Transform3D, k: number): Transform3D {
  if (k === 1) return t;
  return { ...t, position: { x: round(t.position.x * k), y: round(t.position.y * k), z: t.position.z } };
}
