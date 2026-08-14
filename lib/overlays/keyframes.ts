/**
 * Pure keyframe helpers over the additive `OverlayKeyframes` model (Phase 2 of
 * the overlay keyframe feature). Every function takes an overlay (or its
 * keyframes + kind) and returns a `{ keyframes }` PATCH for
 * `updateOverlayInManifest` — none mutate their input. `t` is normalized 0→1
 * within the overlay window (matches `ElementTiming.progress` and the on-disk
 * store; the UI shows absolute timecode).
 *
 * No IO. See `docs-local/superpowers/specs/2026-07-02-overlay-keyframe-animation-design.md`
 * (D1, D2, D9).
 */
import type { Keyframed } from "@/lib/engine/animatable";
import { valueAt } from "@/lib/engine/animatable";
import type { ElementTiming } from "@/lib/engine/overlay-timing";
import { resolveOverlayTransform } from "@/lib/engine/overlay-transform";
import type { Overlay, OverlayKeyframes, OverlayRect, Transform3D } from "@/lib/engine/types";

/** The animatable keyframe track names. */
export type KeyframeProp = "rect" | "opacity" | "transform3d";

/** Overlay kinds — `keyframes` lives on BaseOverlay so every kind carries it. */
type OverlayKind = Overlay["kind"];

/**
 * D9 tracked guard — the single source of truth for which properties may be
 * keyframed on a given overlay kind. `tracked` overlays get their
 * position/scale/rotation from the motion track, so v1 allows OPACITY ONLY
 * (fade the label in/out); everything else allows the full set. `addKeyframeAt`
 * silently ignores disallowed props. The MCP/UI layers surface user-facing
 * errors in later phases; this helper is what they consult.
 */
export function allowedKeyframeProps(kind: OverlayKind): KeyframeProp[] {
  return kind === "tracked" ? ["opacity"] : ["rect", "opacity", "transform3d"];
}

/** A minimal ElementTiming whose only meaningful field is `progress` — enough
 *  for `valueAt`, which reads nothing else. */
function timingAt(t: number): ElementTiming {
  return { frame: 0, time: 0, totalFrames: 1, duration: 1, progress: t };
}

/**
 * The sorted, de-duplicated union of every keyframe `t` across the rect /
 * opacity / transform3d tracks. Empty when the overlay has no keyframes. This
 * is the CapCut single-diamond-row model: one entry per keyframe TIME
 * regardless of which properties are keyed there.
 */
export function overlayKeyframeTimes(overlay: Overlay): number[] {
  const kf = overlay.keyframes;
  if (!kf) return [];
  const times = new Set<number>();
  for (const track of [kf.rect, kf.opacity, kf.transform3d]) {
    if (!track) continue;
    for (const k of track.keyframes) times.add(k.t);
  }
  return Array.from(times).sort((a, b) => a - b);
}

/** The three animatable property values resolved at a given normalized `t`. */
export interface KeyframeSnapshot {
  rect: OverlayRect;
  opacity: number;
  transform3d: Transform3D;
}

/**
 * Resolve the overlay's rect / opacity / transform3d at normalized `t`, reading
 * a keyframe track when one exists and the base field otherwise. `transform3d`
 * falls back to `resolveOverlayTransform(overlay)` (identity + folded legacy
 * rotation), matching the renderer. Used to seed a new keyframe's value.
 */
export function snapshotValues(overlay: Overlay, t: number): KeyframeSnapshot {
  const timing = timingAt(t);
  const kf = overlay.keyframes;
  return {
    rect: valueAt(kf?.rect ?? overlay.rect, timing),
    opacity: valueAt(kf?.opacity ?? overlay.opacity, timing),
    transform3d: valueAt(kf?.transform3d ?? resolveOverlayTransform(overlay), timing),
  };
}

/** A `{ keyframes }` patch as consumed by `updateOverlayInManifest`. `null`
 *  clears the whole field (the persistence sentinel). */
export interface KeyframePatch {
  keyframes: OverlayKeyframes;
}
export interface KeyframeClearPatch {
  keyframes: null;
}

/** Deep-clone a track so the returned patch never shares references with the
 *  input. Values are plain JSON, so structuredClone is safe + exact. */
function cloneTrack<T>(track: Keyframed<T>): Keyframed<T> {
  return structuredClone(track);
}

/** Clone the overlay's keyframes into a fresh, mutable OverlayKeyframes. */
function cloneKeyframes(kf: OverlayKeyframes | undefined): OverlayKeyframes {
  return kf ? structuredClone(kf) : {};
}

/** Index of the key nearest to `t` within `tolerance` (inclusive), or -1 when
 *  none qualifies. Closest wins; on an exact distance tie the lower index wins.
 *  This is the SNAP-TO-KEYFRAME match: an edit landing within half a frame of an
 *  existing keyframe updates THAT keyframe instead of nudging in a duplicate. */
function nearestKeyIndex(keys: { t: number }[], t: number, tolerance: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < keys.length; i++) {
    const d = Math.abs(keys[i].t - t);
    if (d <= tolerance && d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Insert-or-replace a keyframe at `t` on a single track, keeping it sorted.
 *  When `tolerance > 0` an edit within that many normalized units of an existing
 *  keyframe UPDATES it (keeping the existing key's `t` + easing) rather than
 *  inserting a near-duplicate — the CapCut "same frame overwrites" behaviour.
 *  With `tolerance === 0` it falls back to exact-`t` matching (legacy).
 *  The value is deep-cloned so the returned patch never shares a reference with
 *  the caller's snapshot — `snapshotValues`/`valueAt` return the overlay's own
 *  base `rect`/`transform3d` (or the shared `IDENTITY_TRANSFORM3D`) unchanged for
 *  a constant, and storing that reference would alias the base field. */
function upsertKey<T>(
  track: Keyframed<T> | undefined,
  t: number,
  value: T,
  tolerance = 0,
): Keyframed<T> {
  const keys = track ? [...track.keyframes] : [];
  const cloned = structuredClone(value);
  const idx =
    tolerance > 0 ? nearestKeyIndex(keys, t, tolerance) : keys.findIndex((k) => k.t === t);
  if (idx === -1) {
    keys.push({ t, value: cloned });
  } else {
    // Replace value in place; KEEP the matched key's `t` (snap-to-keyframe: an
    // edit near a keyframe updates it without moving its time) and its easing.
    keys[idx] = { ...keys[idx], value: cloned };
  }
  keys.sort((a, b) => a.t - b.t);
  return { keyframes: keys };
}

/**
 * Insert or replace a keyframe at normalized `t`. When `props` is omitted, all
 * ALLOWED properties (see `allowedKeyframeProps`) are snapshotted from the
 * resolved-at-`t` values — seeding a track's first key from the base field.
 * When `props` names a subset, only those (still filtered by the kind's allow
 * list) are keyed. Each track stays sorted; a key at the same `t` is replaced.
 * Returns the full new `OverlayKeyframes` as a patch.
 */
export function addKeyframeAt(
  overlay: Overlay,
  t: number,
  props?: Partial<KeyframeSnapshot>,
  tolerance = 0,
): KeyframePatch {
  const allowed = new Set<KeyframeProp>(allowedKeyframeProps(overlay.kind));
  const next = cloneKeyframes(overlay.keyframes);

  // Values to write: an explicit subset, or a full snapshot when omitted.
  const snap = props ?? snapshotValues(overlay, t);
  const wantRect = props ? props.rect !== undefined : true;
  const wantOpacity = props ? props.opacity !== undefined : true;
  const wantTransform = props ? props.transform3d !== undefined : true;

  if (allowed.has("rect") && wantRect && snap.rect !== undefined) {
    next.rect = upsertKey(next.rect, t, snap.rect as OverlayRect, tolerance);
  }
  if (allowed.has("opacity") && wantOpacity && snap.opacity !== undefined) {
    next.opacity = upsertKey(next.opacity, t, snap.opacity as number, tolerance);
  }
  if (allowed.has("transform3d") && wantTransform && snap.transform3d !== undefined) {
    next.transform3d = upsertKey(next.transform3d, t, snap.transform3d as Transform3D, tolerance);
  }

  return { keyframes: next };
}

/** Remove the keyframe at `t` from a single track. Each keyframe deletes
 *  INDIVIDUALLY: a lone remaining keyframe is KEPT (it pins the value as a
 *  constant hold — CapCut/Premiere behavior, and `valueAt` returns a 1-key
 *  track's value directly). The track is dropped only when NO keyframes remain. */
function deleteFromTrack<T>(track: Keyframed<T> | undefined, t: number): Keyframed<T> | undefined {
  if (!track) return undefined;
  const keys = track.keyframes.filter((k) => k.t !== t);
  if (keys.length === 0) return undefined; // nothing left → drop the track
  return { keyframes: keys };
}

/**
 * Remove the keyframe at `t` from EVERY track (the diamond is the union of all
 * tracks). Deletion is INDIVIDUAL — a track is dropped only when it has NO
 * keyframes left; a single remaining keyframe is kept as a constant-value hold.
 * Returns a `{ keyframes }` patch, or `{ keyframes: null }` when no track
 * survives (clears the field via the persistence null-sentinel).
 */
export function deleteKeyframeAt(overlay: Overlay, t: number): KeyframePatch | KeyframeClearPatch {
  const kf = overlay.keyframes;
  if (!kf) return { keyframes: null };

  const next: OverlayKeyframes = {};
  const rect = deleteFromTrack(kf.rect, t);
  const opacity = deleteFromTrack(kf.opacity, t);
  const transform3d = deleteFromTrack(kf.transform3d, t);
  if (rect) next.rect = cloneTrack(rect);
  if (opacity) next.opacity = cloneTrack(opacity);
  if (transform3d) next.transform3d = cloneTrack(transform3d);

  if (!next.rect && !next.opacity && !next.transform3d) {
    return { keyframes: null };
  }
  return { keyframes: next };
}

/**
 * property→value mapping helpers — the single source of truth for how the flat
 * `position` / `scale` / `rotation` inputs become rect / transform3d values.
 * `mapProperties` (add_keyframe) calls these so property→value conversion has a
 * single source of truth.
 */

/** position → rect: keep base width/height, move the origin to (x, y). */
export function positionToRect(
  baseRect: OverlayRect,
  pos: { x: number; y: number },
): OverlayRect {
  return { ...baseRect, x: pos.x, y: pos.y };
}

/** scale → rect: multiply w/h by `factor` while preserving the rect CENTER. */
export function scaleRectAboutCenter(baseRect: OverlayRect, factor: number): OverlayRect {
  const cx = baseRect.x + baseRect.width / 2;
  const cy = baseRect.y + baseRect.height / 2;
  const width = baseRect.width * factor;
  const height = baseRect.height * factor;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/** rotation (degrees) → transform3d: screen-roll on rotation.z (deg → rad). */
export function rotationDegToTransform(baseTransform: Transform3D, deg: number): Transform3D {
  const rad = (deg * Math.PI) / 180;
  return {
    position: baseTransform.position,
    rotation: { ...baseTransform.rotation, z: rad },
  };
}

/**
 * Set `.easing` on the key at `t` for every track that has one there. Per D3
 * the LEFT keyframe governs the OUTGOING segment. `easing` is a preset id or a
 * literal `cubic-bezier(...)` string. Returns a `{ keyframes }` patch; no-op
 * (returns the cloned keyframes unchanged) when nothing sits at `t`.
 */
export function setSegmentEasing(overlay: Overlay, t: number, easing: string): KeyframePatch {
  const next = cloneKeyframes(overlay.keyframes);
  for (const name of ["rect", "opacity", "transform3d"] as const) {
    const track = next[name];
    if (!track) continue;
    const key = track.keyframes.find((k) => k.t === t);
    if (key) key.easing = easing;
  }
  return { keyframes: next };
}
