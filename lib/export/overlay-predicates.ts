/**
 * Leaf predicates over a single `Overlay`, shared by the export classifier and
 * the base-video resolver.
 *
 * These live in their own module (rather than on `classifier.ts`, where they
 * were originally defined) purely to keep the import graph acyclic:
 * `export-base.ts` needs them, and `classifier.ts` needs `export-base.ts`.
 * This module imports nothing from either, so it can be a dependency of both.
 */
import type { Overlay } from "@/lib/engine/types";
import { resolveOverlayTransform, resolveFlip, classifyTransform } from "@/lib/engine/overlay-transform";

/**
 * True when an overlay carries a transform the ffmpeg `overlay`/`drawtext`
 * fast path can't reproduce: any rotation, flip, or explicit transform3d that
 * is not the identity. (Move/resize/opacity ARE supported by the fast path.)
 * Such an overlay must route the whole export to the pixel-perfect canvas renderer.
 *
 * `resolveOverlayTransform` returns the overlay's `transform3d` (the single
 * rotation authority) or identity; a non-identity planar or spatial transform,
 * or a flip, counts as non-identity.
 */
export function overlayHasNonIdentityTransform(o: Overlay): boolean {
  if (classifyTransform(resolveOverlayTransform(o)) !== "identity") return true;
  const flip = resolveFlip(o);
  return flip.flipH || flip.flipV;
}

/**
 * True when an overlay carries keyframe animation on any of its three tracks
 * (`rect` / `opacity` / `transform3d`) with at least one keyframe present.
 *
 * The ffmpeg `overlay`/`drawtext` fast path composites STATICALLY from the base
 * `rect`/`opacity`/`transform3d` fields — it cannot reproduce per-frame keyframed
 * motion. Even a single-keyframe track resolves via `valueAt` to a value that can
 * differ from the base field the ffmpeg path reads, so the static path would
 * mismatch the animated preview. Gate on >=1 keyframe (not >=2): any keyframe
 * present forces the whole export off the fast path to the canvas/chromium
 * renderer, matching how rotated/flipped and `code` overlays are handled.
 */
export function overlayHasKeyframes(o: Overlay): boolean {
  const kf = o.keyframes;
  if (!kf) return false;
  const tracks = [kf.rect, kf.opacity, kf.transform3d];
  return tracks.some((t) => Array.isArray(t?.keyframes) && t.keyframes.length >= 1);
}
