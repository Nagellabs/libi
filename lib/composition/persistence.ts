import { getStorage } from "@/lib/storage";
import { getAnalysis } from "@/lib/analysis/manager";
import { removeAnalysisForFile } from "@/lib/analysis/cleanup";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { saveCurrentSnapshot, loadCurrentSnapshot } from "./snapshots";
import { navigationEmitter } from "@/lib/navigation-events";
import { hydrateOverlayCode, stripOverlayCode, stripRevealMirror } from "@/lib/overlays/hydrate";
import { writeOverlayCode, listOverlayDirs, deleteOverlayDir } from "@/lib/overlays/code-files";
import { recomputeTextOverlayRect } from "@/lib/captions/persist-rect";
import { flattenCaption } from "@/lib/captions/flat-guard";
import type { TextOverlay } from "@/lib/engine/types";
import { serverLogger as logger } from "@/lib/logger";
import { z } from "zod/v3";
import type {
  CaptionBackground,
  CaptionStroke,
  CaptionShadow,
  CaptionReveal,
  TextThreeD,
  Transform3D,
  OverlayKeyframes,
} from "@/lib/engine/types";

/** Base fields shared by all persisted scene types */
interface PersistedSceneBase {
  id: string;
  name: string;
  duration: number;
}

/** A canvas scene as stored on disk */
export interface PersistedCanvasScene extends PersistedSceneBase {
  type: "canvas";
  drawFunction: string;
}

/**
 * Scene data as stored on disk. Canvas-only — the video-scene variant was
 * retired (2026-07-19) and every on-disk manifest migrated to full-frame video
 * overlays. Kept as an alias because the SCENE concept survives: canvas scenes
 * are still sequential `sceneOrder`-driven base layers in active use.
 */
export type PersistedScene = PersistedCanvasScene;

/** Audio clip stored in the composition manifest. Mirrors the runtime
 *  `AudioClip` from lib/engine/types.ts. */
export interface PersistedAudioClip {
  id: string;
  kind: "inline" | "standalone";
  fileId: string;
  startTime: number;
  duration: number;
  trimStart: number;
  volume: number;
  enabled: boolean;
  linkedSceneId?: string;
  /** Inline clip whose audio comes from a video OVERLAY. At most one of
   *  `linkedSceneId` / `linkedOverlayId` is set. */
  linkedOverlayId?: string;
  /** Vertical placement of a DETACHED track in the timeline stack (same axis as
   *  overlay `z`, higher = nearer the top). Only meaningful for detached clips
   *  (standalone + linkedOverlayId). Never affects render — only row order. */
  timelineOrder?: number;
  label?: string;
  duck?: {
    sidechainClipId: string;
    thresholdDb: number;
    ratio: number;
    attackMs: number;
    releaseMs: number;
    reductionDb: number;
  };
}

/** Caption-group membership + per-cue word timings, as persisted. On text AND
 *  code/three/tracked (a custom overlay built to present captions carries the
 *  same voice-synced timings). Plain JSON — round-trips unchanged. */
type PersistedCaptionRef = {
  groupId: string;
  styleRef?: string;
  useTrackStyle: boolean;
  /** Real per-word timings (element-local seconds) for voice-synced reveals. */
  words?: { text: string; start: number; end: number }[];
};

/** Overlay as persisted on the manifest. Mirrors lib/engine/types.ts Overlay but
 *  with code overlays storing the `drawFunction` body as a string and no
 *  runtime-only fields (compiled functions, image elements). */
export type PersistedOverlay =
  | {
      id: string;
      kind: "text";
      startTime: number;
      duration: number;
      rect: { x: number; y: number; width: number; height: number };
      z: number;
      opacity: number;
      content: string;
      font: string;
      /** Optional uploaded font file id (custom-font upload). Plain JSON —
       *  round-trips through the manifest; renderer + export resolve it. */
      fontFileId?: string;
      color: string;
      align: "left" | "center" | "right";
      flipH?: boolean;
      flipV?: boolean;
      /** Layer OFF everywhere (the persisted eye toggle). Absent ⇒ visible. */
      hidden?: boolean;
      group?: string;
      /** Agent-set display name for the timeline track label (mandatory for
       *  code/three at creation). Plain JSON — round-trips through the manifest. */
      displayName?: string;
      /** Structured caption styling (Milestone 2). Plain JSON — round-trips
       *  through the manifest unchanged; the renderer composes/applies them. */
      fontFamily?: string;
      fontSize?: number;
      fontWeight?: number | string;
      lineHeight?: number;
      background?: CaptionBackground;
      stroke?: CaptionStroke;
      shadow?: CaptionShadow;
      reveal?: CaptionReveal;
      /** Caption-track membership (group style + per-cue override). Plain JSON —
       *  round-trips through the manifest unchanged. Absent ⇒ standalone overlay. */
      caption?: PersistedCaptionRef;
      /** Active-word emphasis color for karaoke reveal. Absent ⇒ derived. */
      highlightColor?: string;
      /** Faux/real 3D extrusion (Milestone 5). Plain JSON — round-trips through
       *  the manifest unchanged; the renderer dispatches a 3D path when present. */
      threeD?: TextThreeD;
      /** 9-point anchor that placement pins (point-text). Plain JSON. See
       *  lib/captions/types.ts CaptionAnchor. */
      anchor?: import("@/lib/captions/types").CaptionAnchor;
      /** Authored anchor point in composition pixels (point-text placement
       *  source of truth). Plain JSON — round-trips through the manifest. */
      position?: { x: number; y: number };
      /** Optional wrap width as a fraction (0..1) of frame width. Unset ⇒
       *  single line (box hugs the text). Plain JSON. */
      maxWidthPct?: number;
      /** The single rotation authority (position + Euler-XYZ rotation, radians).
       *  Absent ⇒ identity. Plain JSON — round-trips through the manifest. */
      transform3d?: Transform3D;
      /** Additive per-property keyframe tracks (Phase 2). Plain JSON — round-trips
       *  through the manifest like `effects`. Absent ⇒ constant properties. */
      keyframes?: OverlayKeyframes;
    }
  | {
      id: string;
      kind: "image";
      startTime: number;
      duration: number;
      rect: { x: number; y: number; width: number; height: number };
      z: number;
      opacity: number;
      flipH?: boolean;
      flipV?: boolean;
      /** Layer OFF everywhere (the persisted eye toggle). Absent ⇒ visible. */
      hidden?: boolean;
      group?: string;
      /** Agent-set display name for the timeline track label (mandatory for
       *  code/three at creation). Plain JSON — round-trips through the manifest. */
      displayName?: string;
      /** 9-point placement anchor (shared across kinds). Plain JSON. */
      anchor?: import("@/lib/captions/types").CaptionAnchor;
      fileId: string;
      /** The single rotation authority (Absent ⇒ identity). Plain JSON. */
      transform3d?: Transform3D;
      /** Additive per-property keyframe tracks (Phase 2). Plain JSON. */
      keyframes?: OverlayKeyframes;
    }
  | {
      id: string;
      kind: "video";
      startTime: number;
      duration: number;
      rect: { x: number; y: number; width: number; height: number };
      z: number;
      opacity: number;
      flipH?: boolean;
      flipV?: boolean;
      /** Layer OFF everywhere (the persisted eye toggle). Absent ⇒ visible. */
      hidden?: boolean;
      group?: string;
      /** Agent-set display name for the timeline track label (mandatory for
       *  code/three at creation). Plain JSON — round-trips through the manifest. */
      displayName?: string;
      /** 9-point placement anchor (shared across kinds). Plain JSON. */
      anchor?: import("@/lib/captions/types").CaptionAnchor;
      fileId: string;
      trim?: { start: number; end: number };
      /** How the source frame fills the rect (`"cover"` default / `"contain"`).
       *  Plain JSON — round-trips through the manifest unchanged. */
      fit?: "cover" | "contain";
      /** The single rotation authority (Absent ⇒ identity). Plain JSON. */
      transform3d?: Transform3D;
      /** Additive per-property keyframe tracks (Phase 2). Plain JSON. */
      keyframes?: OverlayKeyframes;
    }
  | {
      id: string;
      kind: "code";
      startTime: number;
      duration: number;
      rect: { x: number; y: number; width: number; height: number };
      z: number;
      opacity: number;
      flipH?: boolean;
      flipV?: boolean;
      /** Layer OFF everywhere (the persisted eye toggle). Absent ⇒ visible. */
      hidden?: boolean;
      group?: string;
      /** Agent-set display name for the timeline track label (mandatory for
       *  code/three at creation). Plain JSON — round-trips through the manifest. */
      displayName?: string;
      /** 9-point placement anchor (shared across kinds). Plain JSON. */
      anchor?: import("@/lib/captions/types").CaptionAnchor;
      drawFunction: string;
      /** Voice-synced caption words for a custom code caption overlay. Plain JSON. */
      caption?: PersistedCaptionRef;
      /** The single rotation authority (Absent ⇒ identity). Plain JSON. */
      transform3d?: Transform3D;
      /** Additive per-property keyframe tracks (Phase 2). Plain JSON. */
      keyframes?: OverlayKeyframes;
    }
  | {
      id: string;
      kind: "tracked";
      startTime: number;
      duration: number;
      rect: { x: number; y: number; width: number; height: number };
      z: number;
      opacity: number;
      flipH?: boolean;
      flipV?: boolean;
      /** Layer OFF everywhere (the persisted eye toggle). Absent ⇒ visible. */
      hidden?: boolean;
      group?: string;
      /** Agent-set display name for the timeline track label (mandatory for
       *  code/three at creation). Plain JSON — round-trips through the manifest. */
      displayName?: string;
      /** 9-point placement anchor (shared across kinds). Plain JSON. */
      anchor?: import("@/lib/captions/types").CaptionAnchor;
      trackId: string;
      content:
        | { kind: "emoji"; char: string }
        | { kind: "text"; content: string; font: string; color: string; align: "left" | "center" | "right" }
        | { kind: "image"; fileId: string }
        | { kind: "video"; fileId: string; trim?: { start: number; end: number } }
        | { kind: "code"; drawFunction: string }
        | { kind: "effect"; op: "blur" | "pixelate" | "mask" };
      fit: "tight" | "head" | "rect";
      scale: number;
      smoothing: "linear" | "catmull-rom" | "kalman";
      sizeMode?: "stabilized" | "raw";
      maxBoxScale?: number;
      /** Render-time position-stabilization policy. Absent ⇒ "stabilized"
       *  (default — the tracked-overlay bounce fix). Plain JSON. */
      positionMode?: "stabilized" | "raw";
      /** Follow offset in fractions of the resolved art box (see
       *  TrackedOverlay.offset). Plain JSON. */
      offset?: { x: number; y: number };
      /** Voice-synced caption words for a tracked code caption overlay. Plain JSON. */
      caption?: PersistedCaptionRef;
      /** The single rotation authority (Absent ⇒ identity). Plain JSON. */
      transform3d?: Transform3D;
      /** Additive per-property keyframe tracks (Phase 2). Plain JSON. Tracked
       *  overlays keyframe OPACITY ONLY (D9) — the track drives position. */
      keyframes?: OverlayKeyframes;
    }
  | {
      id: string;
      kind: "three";
      startTime: number;
      duration: number;
      rect: { x: number; y: number; width: number; height: number };
      z: number;
      opacity: number;
      flipH?: boolean;
      flipV?: boolean;
      /** Layer OFF everywhere (the persisted eye toggle). Absent ⇒ visible. */
      hidden?: boolean;
      group?: string;
      /** Agent-set display name for the timeline track label (mandatory for
       *  code/three at creation). Plain JSON — round-trips through the manifest. */
      displayName?: string;
      /** 9-point placement anchor (shared across kinds). Plain JSON. */
      anchor?: import("@/lib/captions/types").CaptionAnchor;
      sceneFunction: string;
      cameraPreset?: "billboard" | "ground" | "lowAngle" | "highAngle" | "angled";
      /** Gizmo-driven 3D transform applied to the overlay's scene root. Absent ⇒ identity. */
      transform3d?: Transform3D;
      /** Uniform 3D scene scale (Size control). Absent ⇒ 1. */
      scale?: number;
      /** Voice-synced caption words for a custom three caption overlay. Plain JSON. */
      caption?: PersistedCaptionRef;
      /** Additive per-property keyframe tracks (Phase 2). Plain JSON. */
      keyframes?: OverlayKeyframes;
    };

/** Composition manifest stored as composition.json */
export interface CompositionManifest {
  sceneOrder: string[];
  width: number;
  height: number;
  fps: number;
  audioClips?: PersistedAudioClip[];
  overlays?: PersistedOverlay[];
  /**
   * Inlined scenes. New manifests written by this version always include
   * this field; legacy manifests (pre-snapshot/draft) omit it and the
   * loader falls back to sharded scene-{id}.json files.
   */
  scenes?: PersistedScene[];
}

/** Zod schema for a Vec3 (`{ x, y, z }`) — reused by `transform3dSchema`. */
const vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });

/**
 * Canonical persisted shape for `Transform3D` (position + rotation only; legacy
 * `scale` field is dropped when this schema is applied). Note: `loadManifest` casts
 * `composition.json` directly as `CompositionManifest` and does NOT run this schema
 * at load time — a stray `scale` key on disk is harmless because no runtime path
 * reads it. Use this schema explicitly when validating or normalising a persisted
 * Transform3D value.
 */
export const transform3dSchema = z.object({
  position: vec3Schema,
  rotation: vec3Schema,
});

/** Canonical empty manifest — used as the "no content" baseline throughout
 *  the snapshot/draft system. Import this instead of writing the literal inline. */
export const EMPTY_MANIFEST: CompositionManifest = {
  sceneOrder: [],
  width: 1920,
  height: 1080,
  fps: 30,
  audioClips: [],
  scenes: [],
};

const MANIFEST_FILE = "composition.json";

function sceneFilename(sceneId: string): string {
  return `scene-${sceneId}.json`;
}

/** Load the composition manifest, or return a default if none exists */
export async function loadManifest(pieceId: string): Promise<CompositionManifest> {
  const storage = await getStorage();

  if (!(await storage.exists(pieceId, MANIFEST_FILE))) {
    // Initialize snapshot too so the piece's two-state invariant holds from creation.
    if (!(await loadCurrentSnapshot(pieceId))) {
      await saveCurrentSnapshot(pieceId, EMPTY_MANIFEST);
    }
    // Return a fresh clone — callers mutate the manifest they receive
    // (addOverlayToManifest, saveSceneAndUpdateManifest, …). Handing out
    // the shared EMPTY_MANIFEST constant lets one piece's edits leak into
    // every other file-less piece loaded afterwards.
    return structuredClone(EMPTY_MANIFEST);
  }

  const data = await storage.read(pieceId, MANIFEST_FILE);
  const manifest = JSON.parse(data.toString("utf-8")) as CompositionManifest;

  // Backfill scenes from sharded files for legacy manifests.
  if (!manifest.scenes) {
    const scenes: PersistedScene[] = [];
    for (const sceneId of manifest.sceneOrder) {
      const scene = await loadScene(pieceId, sceneId);
      if (scene) scenes.push(scene);
    }
    manifest.scenes = scenes;
  }

  // Drop the legacy `rotation` (degrees) field: storage now has a single rotation
  // authority (transform3d.rotation.z). Pre-2026-07 manifests may still carry it;
  // no fold, no migration — just drop the key with one warn. (No backward compat.)
  for (const o of manifest.overlays ?? []) {
    if ("rotation" in (o as Record<string, unknown>)) {
      delete (o as Record<string, unknown>).rotation;
      logger.warn(
        { tag: "overlay", op: "legacy_rotation_dropped", pieceId, overlayId: o.id },
        "dropped legacy rotation field",
      );
    }
  }

  // Hydrate code-bearing overlays (code/three/tracked-code) from their files.
  // Legacy composition.json with inline bodies is migrated to files here.
  await hydrateOverlayCode(pieceId, manifest);

  // Lazy snapshot init for legacy pieces. Runs AFTER hydrate so the snapshot
  // captures the inline body (self-contained).
  if (!(await loadCurrentSnapshot(pieceId))) {
    await saveCurrentSnapshot(pieceId, manifest);
  }

  return manifest;
}

/** Save the composition manifest */
export async function saveManifest(pieceId: string, manifest: CompositionManifest): Promise<void> {
  const storage = await getStorage();

  // Recompute the DERIVED rect for every point-text overlay (text + anchor +
  // position). The point-text placement is the source of truth; the rect is a
  // stand-in used for export x/y + hit-test fallback. The server has no canvas,
  // so we use an APPROXIMATE measurer (chars * fontSizePx * 0.5) — the client
  // re-measures exactly at draw/edit time. frameWidth comes from the manifest
  // width (default 1920). Overlays lacking anchor+position are left untouched.
  const frameWidth = manifest.width ?? 1920;
  for (const o of manifest.overlays ?? []) {
    if (o.kind !== "text" || !o.anchor || !o.position) continue;
    const fontSizePx = o.fontSize ?? 48;
    const measure = (s: string) => s.length * fontSizePx * 0.5;
    o.rect = recomputeTextOverlayRect(o, frameWidth, measure);
  }

  // Write each code-bearing overlay's body to its file (from the ORIGINAL
  // manifest whose overlays still hold the bodies), then serialize a stripped
  // clone — code lives in files, not in composition.json. stripOverlayCode
  // returns a clone, so the caller's manifest is never mutated.
  for (const o of manifest.overlays ?? []) {
    await writeOverlayCode(pieceId, o);
  }
  // Strip overlay code bodies (→ files) AND the text-internal reveal mirror
  // (`effects.in` for karaoke/typewriter/…) so `overlay.reveal` is the SINGLE
  // persisted source of truth — a cleared reveal can't resurrect from a stale
  // mirror on the next load (the "can't remove a reveal" bug).
  const onDisk = stripRevealMirror(stripOverlayCode(manifest));
  const data = Buffer.from(JSON.stringify(onDisk, null, 2), "utf-8");
  await storage.save(pieceId, MANIFEST_FILE, data, "application/json");

  // Sweep orphaned scene-*.json shards.
  const keep = new Set((manifest.scenes ?? []).map((s) => sceneFilename(s.id)));
  for (const entry of await storage.list(pieceId)) {
    if (entry.startsWith("scene-") && entry.endsWith(".json") && !keep.has(entry)) {
      await storage.remove(pieceId, entry).catch(() => {});
    }
  }

  // Sweep orphaned overlay dirs (removed overlays leave their code files behind).
  const keepOverlays = new Set((manifest.overlays ?? []).map((o) => o.id));
  for (const id of await listOverlayDirs(pieceId)) {
    if (!keepOverlays.has(id)) await deleteOverlayDir(pieceId, id);
  }

  // Flip hasDraft only if it's currently false (avoid touching updatedAt unnecessarily).
  // Test envs without a DB will throw — skip silently.
  try {
    const db = getDb();
    const [row] = await db.select({ hasDraft: pieces.hasDraft }).from(pieces).where(eq(pieces.id, pieceId));
    if (row && !row.hasDraft) {
      await db.update(pieces).set({ hasDraft: true, updatedAt: new Date() }).where(eq(pieces.id, pieceId));
      navigationEmitter.emit("refresh_query", { queryKey: "piece-state", pieceId });
      navigationEmitter.emit("refresh_query", { queryKey: "pieces" });
    }
  } catch (err) {
    // DB unavailable (e.g. some test contexts) — non-fatal.
  }
}

/** Save a single scene file */
export async function saveScene(pieceId: string, scene: PersistedScene): Promise<void> {
  const storage = await getStorage();
  const data = Buffer.from(JSON.stringify(scene, null, 2), "utf-8");
  await storage.save(pieceId, sceneFilename(scene.id), data, "application/json");
}

/** Load a single scene file */
export async function loadScene(pieceId: string, sceneId: string): Promise<PersistedScene | null> {
  const storage = await getStorage();
  const filename = sceneFilename(sceneId);

  if (!(await storage.exists(pieceId, filename))) {
    return null;
  }

  const data = await storage.read(pieceId, filename);
  const parsed = JSON.parse(data.toString("utf-8"));
  // Backward compatibility: scenes without type field are canvas scenes
  if (!parsed.type) {
    parsed.type = "canvas";
  }
  return parsed;
}

/** Delete a single scene file */
export async function deleteScene(pieceId: string, sceneId: string): Promise<void> {
  const storage = await getStorage();
  await storage.delete(pieceId, sceneFilename(sceneId));
}

/** Load the full composition: manifest + all scene files in order */
export async function loadComposition(pieceId: string): Promise<{
  manifest: CompositionManifest;
  scenes: PersistedScene[];
}> {
  const manifest = await loadManifest(pieceId);
  return { manifest, scenes: manifest.scenes ?? [] };
}

/** Save a scene and update the manifest (add to order if new) */
export async function saveSceneAndUpdateManifest(
  pieceId: string,
  scene: PersistedScene
): Promise<void> {
  const manifest = await loadManifest(pieceId);

  if (!manifest.sceneOrder.includes(scene.id)) {
    manifest.sceneOrder.push(scene.id);
  }

  // Rebuild the full scenes array by loading all scenes in the current order.
  // This ensures the manifest has the canonical scenes list for saveManifest to
  // determine which shards to keep during cleanup.
  const scenes: PersistedScene[] = [];
  for (const sceneId of manifest.sceneOrder) {
    if (sceneId === scene.id) {
      // Use the provided scene if it matches this id
      scenes.push(scene);
    } else {
      // Load existing scenes for other ids
      const existingScene = await loadScene(pieceId, sceneId);
      if (existingScene) scenes.push(existingScene);
    }
  }
  manifest.scenes = scenes;

  await saveScene(pieceId, scene);
  await saveManifest(pieceId, manifest);
}

/**
 * Update an EXISTING scene in place. Writes the shard AND replaces the scene in
 * the inline `manifest.scenes[]` — the source of truth that `loadComposition` /
 * `get_composition` and the renderer read. A plain `saveScene` writes ONLY the
 * shard, which those readers ignore (and the next `saveManifest` orphans), so a
 * trim / drawFunction / duration edit silently vanished while the tool reported
 * success (the silent-write-drop bug found in dogfood).
 * Also resyncs any linked inline AudioClip, since a trim / duration change
 * shifts its timeline position. Returns false when the scene id is not in the
 * manifest so the caller can surface an honest error instead of a false success.
 */
export async function updateSceneInManifest(
  pieceId: string,
  scene: PersistedScene,
): Promise<boolean> {
  // Keep the shard in sync FIRST — loadScene + resyncLinkedClips read it.
  await saveScene(pieceId, scene);
  const manifest = await loadManifest(pieceId);
  const scenes = manifest.scenes ?? [];
  const idx = scenes.findIndex((s) => s.id === scene.id);
  if (idx === -1) return false;
  scenes[idx] = scene;
  manifest.scenes = scenes;
  await resyncLinkedClips(pieceId, manifest);
  await saveManifest(pieceId, manifest);
  return true;
}

/**
 * Re-derive every inline AudioClip's timeline position from its linked
 * scene's actual place in `sceneOrder`. An inline clip's startTime /
 * duration / trimStart is duplicated state: it is computed once, from the
 * sceneOrder snapshot at clip-creation time (video-scene-tools.ts). ANY
 * later scene-layout change — deleting a preceding scene, reordering, or
 * editing a scene's trim/duration — silently desyncs it from the scene it
 * is supposed to voice. Calling this at the end of every scene-layout
 * mutation makes that desync structurally impossible: the position is
 * always derived, never stale.
 *
 * Mutates `manifest.audioClips` in place. Standalone clips are never
 * touched. An inline clip whose linked scene is gone is left as-is for the
 * caller's cascade to drop.
 */
export async function resyncLinkedClips(
  pieceId: string,
  manifest: CompositionManifest,
): Promise<void> {
  const clips = manifest.audioClips;
  if (!clips?.length) return;

  const pos = new Map<
    string,
    { start: number; duration: number; trimStart: number }
  >();
  let acc = 0;
  for (const sid of manifest.sceneOrder) {
    const s = await loadScene(pieceId, sid);
    if (!s) continue;
    // Canvas scenes have no source trim window, so an inline clip linked to
    // one always plays from the top of its file.
    pos.set(sid, { start: acc, duration: s.duration, trimStart: 0 });
    acc += s.duration;
  }

  for (const clip of clips) {
    if (clip.kind !== "inline" || !clip.linkedSceneId) continue;
    const p = pos.get(clip.linkedSceneId);
    if (!p) continue;
    clip.startTime = p.start;
    clip.duration = p.duration;
    clip.trimStart = p.trimStart;
  }
}

/**
 * Remove a scene and update the manifest. Cascades to any linked
 * AudioClip (kind='inline' with linkedSceneId pointing at this scene)
 * so the manifest stays consistent — orphaned linked clips would
 * otherwise reference a scene that no longer exists.
 *
 * Standalone clips and clips linked to OTHER scenes are untouched, but the
 * latter have their timeline position re-derived (deleting a preceding
 * scene shifts every following scene — and thus its audio — earlier).
 *
 * Returns the list of clip ids that were cascaded away so callers can
 * log or notify the user.
 */
export async function removeSceneAndUpdateManifest(
  pieceId: string,
  sceneId: string,
): Promise<{ removedClips: string[] }> {
  const manifest = await loadManifest(pieceId);
  manifest.sceneOrder = manifest.sceneOrder.filter((id) => id !== sceneId);

  const removedClips: string[] = [];
  if (manifest.audioClips) {
    const dropped = manifest.audioClips.filter((c) => c.linkedSceneId === sceneId);
    removedClips.push(...dropped.map((c) => c.id));
    manifest.audioClips = manifest.audioClips.filter((c) => c.linkedSceneId !== sceneId);
  }

  // Rebuild the scenes array to reflect the new sceneOrder.
  if (manifest.scenes) {
    manifest.scenes = manifest.scenes.filter((s) => s.id !== sceneId);
  }

  await deleteScene(pieceId, sceneId);
  await resyncLinkedClips(pieceId, manifest);
  await saveManifest(pieceId, manifest);
  return { removedClips };
}

/** Update scene order in the manifest */
export async function updateSceneOrder(
  pieceId: string,
  sceneIds: string[]
): Promise<void> {
  const manifest = await loadManifest(pieceId);
  manifest.sceneOrder = sceneIds;

  // Rebuild the scenes array to match the new order.
  if (manifest.scenes) {
    const scenes: PersistedScene[] = [];
    for (const sceneId of sceneIds) {
      const scene = manifest.scenes.find((s) => s.id === sceneId);
      if (scene) scenes.push(scene);
    }
    manifest.scenes = scenes;
  }

  await resyncLinkedClips(pieceId, manifest);
  await saveManifest(pieceId, manifest);
}


/** Add an audio clip to the manifest. */
export async function addAudioClip(
  pieceId: string,
  clip: PersistedAudioClip,
): Promise<void> {
  const manifest = await loadManifest(pieceId);
  if (!manifest.audioClips) manifest.audioClips = [];
  manifest.audioClips.push(clip);
  await saveManifest(pieceId, manifest);
}

/** Add an overlay to the manifest. */
export async function addOverlayToManifest(
  pieceId: string,
  overlay: PersistedOverlay,
): Promise<void> {
  const manifest = await loadManifest(pieceId);
  if (!manifest.overlays) manifest.overlays = [];
  manifest.overlays.push(overlay);
  await saveManifest(pieceId, manifest);
}

/** Update an overlay by id. Returns false if not found. */
export async function updateOverlayInManifest(
  pieceId: string,
  overlayId: string,
  patch: Partial<Omit<PersistedOverlay, "id" | "kind">>,
): Promise<boolean> {
  const manifest = await loadManifest(pieceId);
  const overlays = manifest.overlays ?? [];
  const i = overlays.findIndex((o) => o.id === overlayId);
  if (i === -1) return false;
  // Merge the patch, then honour the `null`-clears-key sentinel: a patch value
  // of `null` DELETEs that key from the persisted overlay (used by the caption
  // inspector to turn a styling field — background/stroke/shadow/reveal — back
  // off). A plain `JSON.stringify` would drop `undefined`, so callers must send
  // `null` (not `undefined`) to clear.
  const merged = { ...overlays[i], ...patch } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
  }
  // Monotonic per-overlay version — bumped on every save so the client edit
  // store can reconcile (drop a pending local edit only once the server echoes
  // version >= the one it wrote). Bumped BEFORE flattenCaption, which spreads
  // the overlay and therefore carries the bumped value through.
  (merged as Record<string, unknown>).version =
    ((overlays[i] as { version?: number }).version ?? 0) + 1;
  // Flat-caption guardrail: a flat (non-3D) text caption must never persist a
  // stray 3D X/Y plane rotation that would turn the glyphs edge-on. In-plane
  // rotation (z-roll) is preserved; no-op for a 3D caption.
  const guarded =
    merged.kind === "text"
      ? (flattenCaption(merged as unknown as TextOverlay) as unknown as Record<string, unknown>)
      : merged;
  overlays[i] = guarded as unknown as PersistedOverlay;
  manifest.overlays = overlays;
  await saveManifest(pieceId, manifest);
  return true;
}

/** Remove an overlay by id. Returns false if not found. Cascades to any
 *  inline AudioClip linked to the overlay (linkedOverlayId). */
export async function removeOverlayFromManifest(
  pieceId: string,
  overlayId: string,
): Promise<boolean> {
  const manifest = await loadManifest(pieceId);
  const overlays = manifest.overlays ?? [];
  const before = overlays.length;
  manifest.overlays = overlays.filter((o) => o.id !== overlayId);
  if (manifest.overlays.length === before) return false;
  // Cascade: drop the linked inline audio clip (a silent video overlay has none).
  if (manifest.audioClips) {
    manifest.audioClips = manifest.audioClips.filter(
      (c) => c.linkedOverlayId !== overlayId,
    );
  }
  await saveManifest(pieceId, manifest);
  return true;
}

/** Re-z-order overlays by the given id sequence. Ids not in the list keep their
 *  existing z. Unknown ids are ignored. */
export async function reorderOverlaysInManifest(
  pieceId: string,
  overlayIdsInZOrder: string[],
): Promise<void> {
  const manifest = await loadManifest(pieceId);
  const overlays = manifest.overlays ?? [];
  for (let z = 0; z < overlayIdsInZOrder.length; z++) {
    const id = overlayIdsInZOrder[z];
    const o = overlays.find((x) => x.id === id);
    if (o) o.z = z;
  }
  manifest.overlays = overlays;
  await saveManifest(pieceId, manifest);
}

/**
 * Remove all overlays and audio clips referencing a given fileId.
 *
 * No scene cascade: only the retired video SCENE ever referenced a file, and a
 * canvas scene never can — so file deletion cannot orphan a scene.
 */
export async function removeReferencesToFile(
  pieceId: string,
  fileId: string,
): Promise<{
  removedClips: string[];
  removedOverlays: string[];
  removedAnalysis: boolean;
}> {
  const existingAnalysis = await getAnalysis({ fileId });
  const hadAnalysis = existingAnalysis.steps.length > 0 || existingAnalysis.keyframes.length > 0;

  const manifest = await loadManifest(pieceId);
  const removedClips: string[] = [];

  // Drop image/video overlays referencing this file, including tracked
  // overlays whose content is an image or video asset with the same fileId.
  // Done BEFORE the clip sweep so clips linked to a dropped video overlay
  // (linkedOverlayId) cascade too.
  const removedOverlays: string[] = [];
  if (manifest.overlays) {
    const toDrop = manifest.overlays.filter((o) => {
      if ((o.kind === "image" || o.kind === "video") && o.fileId === fileId) return true;
      if (o.kind === "tracked") {
        const c = o.content;
        if ((c.kind === "image" || c.kind === "video") && c.fileId === fileId) return true;
      }
      return false;
    });
    removedOverlays.push(...toDrop.map((o) => o.id));
    manifest.overlays = manifest.overlays.filter(
      (o) => !toDrop.some((d) => d.id === o.id),
    );
  }

  // Remove audio clips referencing this file or linked to a deleted video
  // overlay.
  if (manifest.audioClips) {
    const clipsToRemove = manifest.audioClips.filter(
      (c) =>
        c.fileId === fileId ||
        (c.linkedOverlayId && removedOverlays.includes(c.linkedOverlayId)),
    );
    removedClips.push(...clipsToRemove.map((c) => c.id));
    manifest.audioClips = manifest.audioClips.filter(
      (c) => !clipsToRemove.some((r) => r.id === c.id),
    );
  }

  // Only persist when the file was actually referenced. Deleting an
  // unreferenced file leaves the composition byte-identical — saving anyway
  // would spuriously flip has_draft and emit piece-state/pieces refreshes.
  if (removedClips.length > 0 || removedOverlays.length > 0) {
    await saveManifest(pieceId, manifest);
  }

  removeAnalysisForFile(pieceId, fileId);

  return { removedClips, removedOverlays, removedAnalysis: hadAnalysis };
}
