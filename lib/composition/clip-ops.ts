// lib/composition/clip-ops.ts
//
// Shared core for the three timeline "clip" gestures — cut (split), delete, and
// duplicate — used IDENTICALLY by the MCP tools (libi.split_clip /
// libi.delete_clip / libi.duplicate_clip) and the timeline right-click menu's
// REST route. One transactional `loadManifest → mutate → saveManifest` per op.
//
// A "clip" here is any of the three timeline entity families, auto-detected from
// a single id (ids are prefix-disjoint: scene_* / <kind>-* / clip_*):
//   - scene     — a sequential base scene (canvas or video)
//   - overlay   — a layered overlay (text / image / video / code / three / tracked)
//   - audio     — an AudioClip (inline-linked or standalone)
//
// HARD INVARIANT: delete removes the timeline entity only — it never deletes the
// source FILE. None of these ops reach storage or removeReferencesToFile.

import {
  loadManifest,
  saveManifest,
  saveScene,
  resyncLinkedClips,
  removeSceneAndUpdateManifest,
  removeOverlayFromManifest,
  type CompositionManifest,
  type PersistedScene,
  type PersistedOverlay,
  type PersistedAudioClip,
} from "./persistence";
import {
  removeClip,
  splitClip as splitAudioClipPure,
  findInlineClipForScene,
  findInlineClipForOverlay,
} from "./audio-clips";
import { rippleCloseGap } from "./ripple";

/** Minimum half-duration a split may produce (one frame at 30fps). */
const MIN_DURATION_SEC = 1 / 30;

export type ClipFamily = "scene" | "overlay" | "audio";

export type ClipOpError = "clip_not_found" | "split_out_of_bounds";

export type DeleteClipResult =
  | { ok: true; family: ClipFamily; targetId: string; removedClips: string[] }
  | { ok: false; error: ClipOpError };

export type SplitClipResult =
  | { ok: true; family: ClipFamily; headId: string; tailId: string }
  | { ok: false; error: ClipOpError };

export type DuplicateClipResult =
  | { ok: true; family: ClipFamily; newId: string }
  | { ok: false; error: ClipOpError };

// ─── id helpers ────────────────────────────────────────────────────────────

function randSuffix(): string {
  return Math.random().toString(36).substring(2, 10);
}
function newSceneId(): string {
  return `scene_${randSuffix()}`;
}
function newClipId(): string {
  return `clip_${randSuffix()}`;
}
/** New overlay id that keeps the original's kind prefix (img-/vid-/text-/…). */
function dupOverlayId(orig: PersistedOverlay): string {
  const prefix = orig.id.split("-")[0] || orig.kind;
  return `${prefix}-${randSuffix()}`;
}

/**
 * A z value that places a NEW overlay row DIRECTLY BELOW `sourceZ`. The timeline
 * is one-row-per-overlay sorted by z DESCENDING (top = highest z), so "just
 * below the source" = a z strictly between `sourceZ` and the next-lower
 * overlay's z. Returning a distinct value (vs. cloning the source's z) fixes the
 * z-TIE that made a duplicate/split land ABOVE or BELOW the source at random —
 * now every cut/duplicate inserts the new track immediately under the source,
 * and repeated duplicates stack consistently downward.
 */
function zBelow(overlays: PersistedOverlay[], sourceZ: number): number {
  const lower = overlays.map((o) => o.z).filter((z) => z < sourceZ);
  const nextLower = lower.length ? Math.max(...lower) : sourceZ - 1;
  return (sourceZ + nextLower) / 2;
}

// ─── family resolution ───────────────────────────────────────────────────────

function resolveFamily(m: CompositionManifest, id: string): ClipFamily | null {
  if (
    (m.scenes ?? []).some((s) => s.id === id) ||
    m.sceneOrder.includes(id)
  )
    return "scene";
  if ((m.overlays ?? []).some((o) => o.id === id)) return "overlay";
  if ((m.audioClips ?? []).some((c) => c.id === id)) return "audio";
  return null;
}

/** A split at `atTime` (composition seconds) must leave BOTH halves ≥ the
 *  minimum: strictly inside the window AND no sub-frame sliver. */
function splittable(start: number, duration: number, atTime: number): boolean {
  const head = atTime - start;
  const tail = duration - head;
  return head >= MIN_DURATION_SEC && tail >= MIN_DURATION_SEC;
}

/** Global start (seconds) + the scene object for a scene id, walking sceneOrder. */
function sceneWindow(
  m: CompositionManifest,
  sceneId: string,
): { start: number; scene: PersistedScene } | null {
  const scenes = m.scenes ?? [];
  let acc = 0;
  for (const sid of m.sceneOrder) {
    const s = scenes.find((x) => x.id === sid);
    if (!s) continue;
    if (sid === sceneId) return { start: acc, scene: s };
    acc += s.duration;
  }
  return null;
}

// ─── delete ──────────────────────────────────────────────────────────────────

export interface DeleteClipOptions {
  /** "Ripple delete" — after removing the clip, close the hole it left by
   *  shifting every overlay/audio clip that starts at/after its END time left
   *  by its duration. Default false: today's plain-delete behavior (the gap
   *  stays), unchanged for every existing caller. See lib/composition/ripple.ts
   *  for the full semantics writeup.
   *
   *  NO-OP for the scene family: a scene delete already closes its own gap
   *  via `sceneOrder` + `resyncLinkedClips` (see the scene branch of
   *  `deleteClip` below for why layering `rippleCloseGap` on top would
   *  double-shift scene-linked audio). */
  ripple?: boolean;
}

export async function deleteClip(
  pieceId: string,
  targetId: string,
  opts?: DeleteClipOptions,
): Promise<DeleteClipResult> {
  const m = await loadManifest(pieceId);
  const family = resolveFamily(m, targetId);
  if (!family) return { ok: false, error: "clip_not_found" };

  // Capture the target's timeline window BEFORE removal — once the family
  // branch below removes it, `startTime`/`duration` are gone.
  const window = targetWindow(m, family, targetId);

  if (family === "scene") {
    // Cascades the scene's inline audio + resyncs following scenes. Never
    // touches the source file.
    //
    // `ripple` is a documented NO-OP here, deliberately — NOT an oversight.
    // Scene positions are implicit in `sceneOrder`, so removing a scene
    // already closes the gap by construction, and
    // `removeSceneAndUpdateManifest` → `resyncLinkedClips` re-derives every
    // following scene's linked inline audio from the new `sceneOrder` in the
    // same call. Running `rippleCloseGap` on top would shift those same
    // clips a SECOND time — and not just the immediate successor:
    // `resyncLinkedClips` walks the whole order, so a clip two-plus hops
    // downstream can cross back over `gapEnd` and get double-shifted by the
    // ripple pass (verified: S0[0-5) S1(del,5)[5-10) S2[10-16) S3[16-21)
    // with audio linked to S3 — ripple-on-top lands S3's clip at 6 instead
    // of the correct 11). We intentionally do NOT chase the "precise" fix
    // (ripple overlays / non-scene-linked audio only) — the entire scene
    // branch of deleteClip is being retired in the very next task, so that
    // extra complexity has no lifespan left to earn its keep.
    const { removedClips } = await removeSceneAndUpdateManifest(pieceId, targetId);
    return { ok: true, family, targetId, removedClips };
  }

  if (family === "overlay") {
    // Cascades a video overlay's coupled inline audio (linkedOverlayId).
    // removeOverlayFromManifest saves internally, so the ripple pass below is
    // a deliberate SECOND save layered on top — not a double-write of the
    // same change.
    await removeOverlayFromManifest(pieceId, targetId);
    if (opts?.ripple && window) await closeGapAfterDelete(pieceId, window);
    return { ok: true, family, targetId, removedClips: [] };
  }

  // audio
  const next = removeClip(m, targetId);
  if (!next) return { ok: false, error: "clip_not_found" };
  await saveManifest(pieceId, next);
  if (opts?.ripple && window) await closeGapAfterDelete(pieceId, window);
  return { ok: true, family, targetId, removedClips: [] };
}

/** The target's timeline window (composition-global start + duration) BEFORE
 *  removal, used to drive the post-delete ripple. Returns null if the family
 *  or id can't be resolved to a window (shouldn't happen — resolveFamily
 *  already confirmed the id exists). */
function targetWindow(
  m: CompositionManifest,
  family: ClipFamily,
  targetId: string,
): { start: number; duration: number } | null {
  if (family === "scene") {
    const win = sceneWindow(m, targetId);
    return win ? { start: win.start, duration: win.scene.duration } : null;
  }
  if (family === "overlay") {
    const o = (m.overlays ?? []).find((x) => x.id === targetId);
    return o ? { start: o.startTime, duration: o.duration } : null;
  }
  const c = (m.audioClips ?? []).find((x) => x.id === targetId);
  return c ? { start: c.startTime, duration: c.duration } : null;
}

/** Reload the (already-saved) post-delete manifest, close the gap the deleted
 *  clip left, and save. A separate pass from the family-specific removal
 *  above so it composes cleanly with `removeOverlayFromManifest`'s internal
 *  save instead of racing it.
 *
 *  Skips the save entirely when nothing would actually move (e.g. deleting
 *  the LAST clip on the timeline) — `rippleCloseGap`'s own `byDuration > 0`
 *  guard only covers a zero-duration gap, not "no item happens to sit at/after
 *  it", so that check has to happen here. */
async function closeGapAfterDelete(
  pieceId: string,
  window: { start: number; duration: number },
): Promise<void> {
  const post = await loadManifest(pieceId);
  const gapEnd = window.start + window.duration;
  const wouldShift =
    (post.overlays ?? []).some((o) => o.startTime >= gapEnd) ||
    (post.audioClips ?? []).some((c) => c.startTime >= gapEnd);
  if (!wouldShift) return;
  const rippled = rippleCloseGap(post, window.start, window.duration);
  await saveManifest(pieceId, rippled);
}

// ─── split (cut) ─────────────────────────────────────────────────────────────

export async function splitClip(
  pieceId: string,
  targetId: string,
  atTime: number,
): Promise<SplitClipResult> {
  const m = await loadManifest(pieceId);
  const family = resolveFamily(m, targetId);
  if (!family) return { ok: false, error: "clip_not_found" };

  if (family === "audio") return splitAudio(pieceId, m, targetId, atTime);
  if (family === "overlay") return splitOverlay(pieceId, m, targetId, atTime);
  return splitScene(pieceId, m, targetId, atTime);
}

async function splitAudio(
  pieceId: string,
  m: CompositionManifest,
  clipId: string,
  atTime: number,
): Promise<SplitClipResult> {
  const clip = (m.audioClips ?? []).find((c) => c.id === clipId)!;
  if (!splittable(clip.startTime, clip.duration, atTime))
    return { ok: false, error: "split_out_of_bounds" };

  const before = new Set((m.audioClips ?? []).map((c) => c.id));
  const next = splitAudioClipPure(m, clipId, atTime);
  if (!next) return { ok: false, error: "split_out_of_bounds" };
  const tail = (next.audioClips ?? []).find((c) => !before.has(c.id));
  await saveManifest(pieceId, next);
  return { ok: true, family: "audio", headId: clipId, tailId: tail?.id ?? clipId };
}

async function splitOverlay(
  pieceId: string,
  m: CompositionManifest,
  overlayId: string,
  atTime: number,
): Promise<SplitClipResult> {
  const overlays = m.overlays ?? [];
  const idx = overlays.findIndex((o) => o.id === overlayId);
  const head = overlays[idx];
  const origDuration = head.duration;
  if (!splittable(head.startTime, origDuration, atTime))
    return { ok: false, error: "split_out_of_bounds" };

  const localOffset = atTime - head.startTime;
  const tail = structuredClone(head) as PersistedOverlay;
  tail.id = dupOverlayId(head);
  tail.startTime = atTime;
  tail.duration = origDuration - localOffset;
  // New track DIRECTLY BELOW the head (distinct z, not a clone-tie).
  tail.z = zBelow(overlays, head.z);
  head.duration = localOffset;

  // Video overlays carry a source trim window; split it at the cut point.
  if (head.kind === "video" && tail.kind === "video") {
    const t0 = head.trim?.start ?? 0;
    head.trim = { start: t0, end: t0 + localOffset };
    tail.trim = { start: t0 + localOffset, end: t0 + origDuration };
  }

  overlays.splice(idx + 1, 0, tail);
  m.overlays = overlays;

  // A video overlay's coupled inline audio (linkedOverlayId) has no
  // resyncLinkedClips equivalent — snap the two halves to their windows by hand.
  if (head.kind === "video") {
    const inline = findInlineClipForOverlay(m, overlayId);
    if (inline) {
      inline.startTime = head.startTime;
      inline.duration = head.duration;
      inline.trimStart = head.kind === "video" ? head.trim?.start ?? inline.trimStart : inline.trimStart;
      const tailClip: PersistedAudioClip = {
        ...structuredClone(inline),
        id: newClipId(),
        linkedOverlayId: tail.id,
        startTime: tail.startTime,
        duration: tail.duration,
        trimStart: tail.kind === "video" ? tail.trim?.start ?? 0 : 0,
      };
      m.audioClips = [...(m.audioClips ?? []), tailClip];
    }
  }

  await saveManifest(pieceId, m);
  return { ok: true, family: "overlay", headId: overlayId, tailId: tail.id };
}

async function splitScene(
  pieceId: string,
  m: CompositionManifest,
  sceneId: string,
  atTime: number,
): Promise<SplitClipResult> {
  const win = sceneWindow(m, sceneId);
  if (!win) return { ok: false, error: "clip_not_found" };
  const { start: sceneStart, scene } = win;
  const origDuration = scene.duration;
  if (!splittable(sceneStart, origDuration, atTime))
    return { ok: false, error: "split_out_of_bounds" };

  const localOffset = atTime - sceneStart;
  const tailId = newSceneId();
  const tail = structuredClone(scene) as PersistedScene;
  tail.id = tailId;
  tail.duration = origDuration - localOffset;

  // Canvas scenes carry no source trim window — splitting is purely a duration
  // cut (video scenes, which did need a trim split, were retired).
  scene.duration = localOffset;

  // Insert the tail scene right after the head in both order + inline scenes.
  const scenes = m.scenes ?? [];
  const sIdx = scenes.findIndex((s) => s.id === sceneId);
  scenes.splice(sIdx + 1, 0, tail);
  m.scenes = scenes;
  const oIdx = m.sceneOrder.indexOf(sceneId);
  m.sceneOrder.splice(oIdx + 1, 0, tailId);

  // Persist both shards BEFORE resync (it reads shards via loadScene).
  await saveScene(pieceId, scene);
  await saveScene(pieceId, tail);

  // Give the tail scene its own inline audio clip (a clone of the head's).
  const headClip = findInlineClipForScene(m, sceneId);
  if (headClip) {
    const tailClip: PersistedAudioClip = {
      ...structuredClone(headClip),
      id: newClipId(),
      linkedSceneId: tailId,
    };
    m.audioClips = [...(m.audioClips ?? []), tailClip];
  }

  // Derives both inline clips' startTime/duration/trimStart from the shards.
  await resyncLinkedClips(pieceId, m);
  await saveManifest(pieceId, m);
  return { ok: true, family: "scene", headId: sceneId, tailId };
}

// ─── duplicate ───────────────────────────────────────────────────────────────

export async function duplicateClip(
  pieceId: string,
  targetId: string,
): Promise<DuplicateClipResult> {
  const m = await loadManifest(pieceId);
  const family = resolveFamily(m, targetId);
  if (!family) return { ok: false, error: "clip_not_found" };

  if (family === "audio") return duplicateAudio(pieceId, m, targetId);
  if (family === "overlay") return duplicateOverlay(pieceId, m, targetId);
  return duplicateScene(pieceId, m, targetId);
}

async function duplicateAudio(
  pieceId: string,
  m: CompositionManifest,
  clipId: string,
): Promise<DuplicateClipResult> {
  const src = (m.audioClips ?? []).find((c) => c.id === clipId)!;
  const copy: PersistedAudioClip = {
    ...structuredClone(src),
    id: newClipId(),
    // A duplicated clip is a FREE copy — not coupled to the source's scene/overlay.
    kind: "standalone",
    startTime: src.startTime + src.duration,
    label: src.label ? `${src.label} copy` : src.label,
  };
  delete copy.linkedSceneId;
  delete copy.linkedOverlayId;
  copy.timelineOrder = undefined;
  m.audioClips = [...(m.audioClips ?? []), copy];
  await saveManifest(pieceId, m);
  return { ok: true, family: "audio", newId: copy.id };
}

async function duplicateOverlay(
  pieceId: string,
  m: CompositionManifest,
  overlayId: string,
): Promise<DuplicateClipResult> {
  const overlays = m.overlays ?? [];
  const idx = overlays.findIndex((o) => o.id === overlayId);
  const src = overlays[idx];
  const copy = structuredClone(src) as PersistedOverlay;
  copy.id = dupOverlayId(src);
  copy.startTime = src.startTime + src.duration; // adjacent in time
  // New track DIRECTLY BELOW the source (distinct z, not a clone-tie) so the
  // copy always lands in the same place instead of above/below at random.
  copy.z = zBelow(overlays, src.z);
  if (copy.displayName) copy.displayName = `${copy.displayName} copy`;
  overlays.splice(idx + 1, 0, copy);
  m.overlays = overlays;

  // Carry a video overlay's coupled inline audio onto the copy.
  if (src.kind === "video") {
    const inline = findInlineClipForOverlay(m, overlayId);
    if (inline) {
      const clipCopy: PersistedAudioClip = {
        ...structuredClone(inline),
        id: newClipId(),
        linkedOverlayId: copy.id,
        startTime: copy.startTime,
        duration: copy.duration,
      };
      m.audioClips = [...(m.audioClips ?? []), clipCopy];
    }
  }

  await saveManifest(pieceId, m);
  return { ok: true, family: "overlay", newId: copy.id };
}

async function duplicateScene(
  pieceId: string,
  m: CompositionManifest,
  sceneId: string,
): Promise<DuplicateClipResult> {
  const scenes = m.scenes ?? [];
  const sIdx = scenes.findIndex((s) => s.id === sceneId);
  if (sIdx === -1) return { ok: false, error: "clip_not_found" };
  const src = scenes[sIdx];
  const copy = structuredClone(src) as PersistedScene;
  copy.id = newSceneId();
  copy.name = `${src.name} copy`;
  scenes.splice(sIdx + 1, 0, copy);
  m.scenes = scenes;
  const oIdx = m.sceneOrder.indexOf(sceneId);
  m.sceneOrder.splice(oIdx + 1, 0, copy.id);
  await saveScene(pieceId, copy);

  const headClip = findInlineClipForScene(m, sceneId);
  if (headClip) {
    const clipCopy: PersistedAudioClip = {
      ...structuredClone(headClip),
      id: newClipId(),
      linkedSceneId: copy.id,
    };
    m.audioClips = [...(m.audioClips ?? []), clipCopy];
  }

  await resyncLinkedClips(pieceId, m);
  await saveManifest(pieceId, m);
  return { ok: true, family: "scene", newId: copy.id };
}
