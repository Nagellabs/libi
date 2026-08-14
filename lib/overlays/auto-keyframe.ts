/**
 * Pure decision helper for Phase 5b AUTO-KEYFRAMING.
 *
 * Once an overlay is already "animated" (has ≥1 keyframe), a manual rect /
 * opacity / transform3d edit at the playhead should CREATE/UPDATE a keyframe at
 * the playhead time instead of writing the flat base field. A still-constant
 * overlay (no keyframes) edits EXACTLY as before — a flat PATCH.
 *
 * This module owns ONLY the decision + the shaping of the keyframes-route body;
 * it does no IO and touches no React. The commit hook branches on the result:
 * `flat` → the existing flat PATCH (byte-identical to today); `keyframe` →
 * POST the keyframes route with `{ time, properties }`.
 *
 * `time` is SECONDS within the overlay clip window (`0..duration`), matching
 * `useKeyframeOps(pieceId).add` and the `/keyframes` route schema. It is
 * computed as `playheadTime − startTime` and CLAMPED to `[0, duration]` — a
 * playhead outside the clip window pins to the nearest edge (the overlay is
 * only visible inside `[startTime, startTime+duration)`, so an out-of-window
 * edit is an edge case; clamping keeps the write in-range rather than dropping
 * to a flat write that would desync the animated overlay's base field).
 */

/** The single animatable field a manual transform edit may carry. */
export type AutoKeyframeField = "rect" | "opacity" | "transform3d";

export interface AutoKeyframeInput {
  /** Whether the overlay already has ≥1 keyframe (from `overlayKeyframeTimes`). */
  hasKeyframes: boolean;
  /** Which animatable field this edit changed. */
  field: AutoKeyframeField;
  /** The edited value (verbatim — passed through to the route's `properties`). */
  value: unknown;
  /** Composition-global playhead time in seconds at commit. */
  playheadTime: number;
  /** The overlay's `startTime` (composition-global seconds). */
  startTime: number;
  /** The overlay's `duration` (seconds). */
  duration: number;
}

export type AutoKeyframeDecision =
  | { mode: "flat" }
  | {
      mode: "keyframe";
      /** Clip-relative SECONDS, clamped to `[0, duration]`. */
      time: number;
      /** The keyframes-route `properties` body: `{ <field>: value }`. */
      properties: Record<string, unknown>;
    };

/** Clamp `v` into `[lo, hi]` (assumes `lo <= hi`). */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A debounced keyframe intent accumulated across a drag. The commit hook merges
 * each per-tick keyframe decision into ONE of these per overlay, then fires a
 * single `addKeyframe` POST when the drag settles. `time` is the LATEST playhead
 * offset (stable during a drag); `properties` merges field-by-field so a drag
 * that touches multiple animatable fields (e.g. rect + opacity) lands them all.
 */
export interface PendingKeyframe {
  /** Clip-relative SECONDS for the keyframe (latest decision wins). */
  time: number;
  /** The keyframes-route `properties` body, merged by field across ticks. */
  properties: Record<string, unknown>;
}

/**
 * Merge a fresh keyframe decision into the pending intent for one overlay.
 * Pure — returns a NEW `PendingKeyframe` (never mutates `prev`). Properties are
 * merged field-by-field (latest value per field wins); `time` takes the newest
 * decision's value (the playhead is stable during a single drag, so this is a
 * no-op in practice, but a later drag at a new playhead correctly re-targets).
 */
export function mergePendingKeyframe(
  prev: PendingKeyframe | undefined,
  next: { time: number; properties: Record<string, unknown> },
): PendingKeyframe {
  return {
    time: next.time,
    properties: { ...(prev?.properties ?? {}), ...next.properties },
  };
}

/**
 * Decide whether a rect / opacity / transform3d edit commits as a flat PATCH
 * (overlay has no keyframes) or as a keyframe upsert at the playhead (overlay
 * already animated). Pure — no IO.
 */
export function autoKeyframeCommit(input: AutoKeyframeInput): AutoKeyframeDecision {
  if (!input.hasKeyframes) {
    return { mode: "flat" };
  }
  const duration = input.duration > 0 ? input.duration : 0;
  const time = clamp(input.playheadTime - input.startTime, 0, duration);
  return {
    mode: "keyframe",
    time,
    properties: { [input.field]: input.value },
  };
}
