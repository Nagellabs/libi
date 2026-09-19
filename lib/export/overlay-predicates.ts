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

/** Plates rounder than this (composition px) route to the chromium renderer:
 *  drawbox has only square corners, and a square corner sits r(√2 − 1) ≈ 0.41 r
 *  off the rounded one — ≤ 3.3 px up to here, the "within a few px" the export
 *  promises. */
export const PLATE_RADIUS_SQUARE_MAX = 8;

/** Glyphs drawtext can't draw: pictographic emoji (a colour-emoji font
 *  fallback the browser does and freetype doesn't), regional-indicator flags
 *  and keycaps. ©, ® and ™ are Extended_Pictographic too but are ordinary
 *  glyphs in any text font, so they stay on the fast path. */
const EMOJI_RE = /(?![©®™])\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|⃣/u;

/**
 * True when a TEXT overlay draws something the ffmpeg `drawtext` path can't
 * reproduce, so the export must go to the chromium renderer (which runs the
 * preview's own renderer):
 *   - a reveal (typewriter / fade-words / slide-up / pop / karaoke /
 *     word-current / flythrough) — it animates, drawtext draws static text;
 *   - emoji — see EMOJI_RE;
 *   - a background plate rounder than `PLATE_RADIUS_SQUARE_MAX` — drawbox
 *     corners are square.
 * Wrap, stroke, shadow (hard or blurred) and square-ish plates ARE reproduced.
 */
export function textNeedsBrowserRender(o: Overlay): boolean {
  if (o.kind !== "text") return false;
  if (o.reveal && o.reveal.mode !== "none") return true;
  if (EMOJI_RE.test(o.content ?? "")) return true;
  if (o.background && (o.background.radius ?? 0) > PLATE_RADIUS_SQUARE_MAX) return true;
  return false;
}
