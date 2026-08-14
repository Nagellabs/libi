/**
 * Resolve a composition's BASE VIDEO for the server-side ffmpeg export
 * backends — the single full-frame video layer that becomes ffmpeg input `[0:v]`.
 *
 * Historically the base was always `scenes[0]` (a video SCENE). Video scenes
 * were retired (2026-07-19) and a video is now an OVERLAY, so the base is
 * always the bottom full-frame, untransformed video overlay. This module is the
 * shared predicate + resolver both the classifier and the backends read, so
 * they can never disagree about what the base is.
 *
 * Deliberately strict: any overlay the ffmpeg graph could not reproduce
 * pixel-for-pixel (partial opacity, contain-fit letterbox, rotation, keyframed
 * motion, a non-zero start) disqualifies the fast path and the caller falls back
 * to chromium-render. A false negative costs render time; a false positive ships
 * a wrong video.
 */
import type { AudioClip, Composition, Overlay, VideoOverlay } from "@/lib/engine/types";
import { overlayHasKeyframes, overlayHasNonIdentityTransform } from "@/lib/export/overlay-predicates";

export interface ExportBase {
  fileId: string;
  duration: number;
  trim?: { start: number; end: number };
  /** Overlay id of the base video overlay. */
  overlayId: string;
  /** SOURCE pixel dimensions of the base file, when known. Runtime-only: the
   *  hydrators (`buildComposition` client-side, the export routes server-side)
   *  copy them off `files.mediaWidth/mediaHeight`, which is nullable. `null`
   *  means UNKNOWN — never "matches". */
  sourceWidth: number | null;
  sourceHeight: number | null;
}

/** Lowest z among all overlays, or null when there are none. */
function minZ(overlays: Overlay[]): number | null {
  if (!overlays.length) return null;
  return overlays.reduce((m, o) => Math.min(m, o.z ?? 0), Number.POSITIVE_INFINITY);
}

/**
 * True when this overlay can serve as ffmpeg's base input: a full-canvas,
 * opaque, cover-fit, untransformed, unkeyframed video starting at t=0 and
 * sitting at the bottom of the stack.
 */
export function isBaseShapedVideoOverlay(o: Overlay, comp: Composition): boolean {
  if (o.kind !== "video") return false;
  if (o.startTime !== 0) return false;
  if (o.opacity != null && o.opacity !== 1) return false;
  if ((o.fit ?? "cover") !== "cover") return false;
  if (o.rect.x !== 0 || o.rect.y !== 0) return false;
  if (o.rect.width !== comp.width || o.rect.height !== comp.height) return false;
  if (overlayHasNonIdentityTransform(o)) return false;
  if (overlayHasKeyframes(o)) return false;
  // Any in/out/loop effect ref can't be reproduced by the static ffmpeg
  // overlay/drawtext graph — reject rather than guess whether it's benign.
  if (o.effects && (o.effects.in || o.effects.out || o.effects.loop)) return false;
  const lowest = minZ(comp.overlays ?? []);
  return lowest != null && (o.z ?? 0) === lowest;
}

/**
 * The composition's base video, or null when it has none (in which case the
 * caller must use chromium-render).
 */
export function resolveExportBase(comp: Composition): ExportBase | null {
  // Any canvas scene means a JS draw function the ffmpeg graph cannot run.
  if (comp.scenes.length > 0) return null;

  const overlays = comp.overlays ?? [];
  // Additional video overlays above the base are FINE — the ffmpeg-overlay
  // backend composites them as extra `-i` inputs. That is exactly the shape
  // background-removal produces (a full-frame plate + inset cutouts), and
  // rejecting it would send every such export through headless Chromium.
  // Only the BASE must be unambiguous.
  const bases = overlays.filter(
    (o): o is VideoOverlay => o.kind === "video" && isBaseShapedVideoOverlay(o, comp),
  );
  // `isBaseShapedVideoOverlay` requires the LOWEST z, so at most one overlay
  // can qualify — but assert it rather than assume: an ambiguous base is a
  // wrong video, and falling back is always safe.
  if (bases.length !== 1) return null;
  const base = bases[0];
  return {
    fileId: base.fileId,
    duration: base.duration,
    trim: base.trim,
    overlayId: base.id,
    sourceWidth: base.sourceWidth ?? null,
    sourceHeight: base.sourceHeight ?? null,
  };
}

/**
 * The base's OUTPUT time range, in source seconds.
 *
 * `trim` selects a range of the SOURCE file; `duration` is how long the layer
 * occupies the TIMELINE. The renderer draws the layer for `duration` seconds
 * starting at `trim.start` (see `overlay-renderer.ts`), so the exported cut is
 * the SHORTER of the two — a trim whose span exceeds `duration` (split a clip,
 * then drag its right edge in, which rewrites `duration` but not `trim`) would
 * otherwise emit a file longer than the preview showed.
 *
 * Both ffmpeg backends and the classifier's truncation guard read this, so they
 * cannot disagree about where the output ends.
 */
export function baseTimeRange(base: ExportBase): {
  start: number;
  end: number;
  duration: number;
} {
  const start = base.trim?.start ?? 0;
  const end = Math.min(base.trim?.end ?? Number.POSITIVE_INFINITY, start + base.duration);
  return { start, end, duration: end - start };
}

/**
 * True when `-c copy` would preserve the composition's framing.
 *
 * Stream-copy ships the source's bytes verbatim — it cannot scale, pad, or
 * crop — so the output carries the SOURCE's dimensions. That is only correct
 * when the source already matches the composition. A 16:9 clip dropped into a
 * 9:16 short is base-shaped by construction (`add_overlay` defaults every video
 * to a full-canvas `cover` rect), and stream-copying it silently ships a
 * landscape file for a portrait piece.
 *
 * UNKNOWN dimensions (`null` — the file row was never probed) count as a
 * MISMATCH: a false negative costs one re-encode, a false positive ships the
 * wrong aspect ratio.
 */
export function streamCopyPreservesFraming(base: ExportBase, comp: Composition): boolean {
  if (base.sourceWidth == null || base.sourceHeight == null) return false;
  return base.sourceWidth === comp.width && base.sourceHeight === comp.height;
}

/**
 * The inline AudioClip that represents the BASE layer's own audio track, if any.
 * Matched by `linkedOverlayId`.
 *
 * Muting a base video REMOVES its inline clip (`libi.audio_remove_clip`), so
 * "no clip" means "no base audio" — not "keep whatever the source had". Both
 * ffmpeg backends must drop the source's audio track in that case.
 */
export function findBaseInlineAudioClip(
  comp: Composition,
  base: ExportBase,
): AudioClip | undefined {
  return (comp.audioClips ?? []).find(
    (c) => c.kind === "inline" && c.linkedOverlayId === base.overlayId,
  );
}

/** True when the base's own audio must be carried into the export. */
export function keepsBaseAudio(comp: Composition, base: ExportBase): boolean {
  const clip = findBaseInlineAudioClip(comp, base);
  return clip !== undefined && clip.enabled;
}
