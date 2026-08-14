/**
 * Pure helpers for the Keyframes tab's left-column keyframe LIST — one row per
 * keyframe TIME (the union across the rect/opacity/transform3d tracks). Every
 * time display uses `frameToTimecode` (HH:MM:SS:FF) so the list matches the
 * timeline ruler exactly (no decimal-seconds notation anywhere). Dependency-free
 * except the shared registries; unit-tested in
 * `__tests__/unit/preview/keyframe-list.test.ts`.
 */
import type { Overlay } from "@/lib/engine/types";
import { overlayKeyframeTimes } from "@/lib/overlays/keyframes";
import { EASING_PRESETS } from "@/lib/engine/easing-registry";
import { frameToTimecode } from "@/lib/preview/timecode";

/**
 * Read the easing string on the LEFT keyframe at normalized `t` (per D3 the left
 * keyframe governs the outgoing segment). Reads whichever track carries an
 * easing at that exact time; `undefined` when none set. Single source of truth —
 * `keyframe-curve-editor.tsx` imports this instead of a local copy.
 */
export function easingAt(overlay: Overlay, t: number): string | undefined {
  const kf = overlay.keyframes;
  if (!kf) return undefined;
  for (const track of [kf.rect, kf.opacity, kf.transform3d]) {
    if (!track) continue;
    const key = track.keyframes.find((k) => k.t === t);
    if (key?.easing) return key.easing;
  }
  return undefined;
}

/** The display label for a keyframe's OUTGOING-segment easing. */
export function easingLabelFor(easingId: string | undefined, isLast: boolean): string {
  if (isLast) return "— end —";
  const preset = EASING_PRESETS.find((p) => p.id === easingId);
  if (preset) return preset.label;
  if (easingId && easingId.startsWith("cubic-bezier(")) return "Custom";
  // undefined → linear is the honest effective default (resolveEasing(undefined)).
  return "Linear";
}

/** One row of the keyframe list — a single keyframe on the timeline. */
export interface KeyframeRow {
  /** Normalized keyframe time 0→1 within the overlay window. */
  t: number;
  /** Frame index within the composition (for the animated timecode count-up). */
  frame: number;
  /** HH:MM:SS:FF timecode string (matches the timeline ruler). */
  timecode: string;
  /** The outgoing-segment easing id, or undefined (⇒ linear). */
  easingId: string | undefined;
  /** Display label for the easing (preset label / "Custom" / "Linear" / "— end —"). */
  easingLabel: string;
  /** True for the last keyframe — it has no outgoing segment. */
  isLast: boolean;
}

/**
 * Build the keyframe-row list for an overlay: one row per keyframe time (the
 * sorted union across all tracks), each with its HH:MM:SS:FF timecode + outgoing
 * easing label. Empty when the overlay has no keyframes.
 */
export function keyframeRows(overlay: Overlay, fps: number): KeyframeRow[] {
  const times = overlayKeyframeTimes(overlay);
  const duration = overlay.duration > 0 ? overlay.duration : 1;
  const safeFps = fps > 0 ? fps : 30;
  return times.map((t, i) => {
    const seconds = t * duration;
    const frame = Math.round(seconds * safeFps);
    const isLast = i === times.length - 1;
    const easingId = easingAt(overlay, t);
    return {
      t,
      frame,
      timecode: frameToTimecode(frame, fps),
      easingId,
      easingLabel: easingLabelFor(easingId, isLast),
      isLast,
    };
  });
}
