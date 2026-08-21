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
import { unresolvedFamilies, familyFromFont } from "@/lib/fonts/resolve";
import { sanitizeDuck } from "@/lib/audio/duck-params";
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
  /** Inline clip whose audio comes from a video OVERLAY. */
  linkedOverlayId?: string;
  /** Vertical placement of a DETACHED track in the timeline stack (same axis as
   *  overlay `z`, higher = nearer the top). Only meaningful for detached clips
   *  (standalone + linkedOverlayId). Never affects render — only row order. */
  timelineOrder?: number;
  label?: string;
  duck?: {
    /** Sidechain clips driving the duck. Written as an array since
     *  2026-08-18; `loadManifest` normalizes older manifests through
     *  `sanitizeDuck`, so a loaded clip always has this. */
    sidechainClipIds?: string[];
    /** @deprecated Pre-2026-08-18 single-sidechain spelling. Read, never written. */
    sidechainClipId?: string;
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
  width: number;
  height: number;
  fps: number;
  audioClips?: PersistedAudioClip[];
  overlays?: PersistedOverlay[];
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
  width: 1920,
  height: 1080,
  fps: 30,
  audioClips: [],
};

const MANIFEST_FILE = "composition.json";

/**
 * Has this piece ever had a composition saved? A cheap existence check that,
 * unlike `loadManifest`, has NO side effects — `loadManifest` initialises a
 * snapshot for a piece that has none, so using it to ask "is this piece built?"
 * quietly creates state for a piece you were about to reject.
 *
 * Exists so callers can distinguish a fully-built piece from a shell that a
 * killed process left behind, without duplicating the filename constant.
 */
export async function hasManifest(pieceId: string): Promise<boolean> {
  const storage = await getStorage();
  return storage.exists(pieceId, MANIFEST_FILE);
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
    // (addOverlayToManifest, addAudioClip, …). Handing out
    // the shared EMPTY_MANIFEST constant lets one piece's edits leak into
    // every other file-less piece loaded afterwards.
    return structuredClone(EMPTY_MANIFEST);
  }

  const data = await storage.read(pieceId, MANIFEST_FILE);
  const manifest = JSON.parse(data.toString("utf-8")) as CompositionManifest;

  // A pre-2026-08-20 manifest may still carry `scenes` / `sceneOrder`. The
  // canvas-scene layer is gone; ignore both rather than throwing, so an old
  // manifest still opens (as its overlays) instead of failing to load.
  delete (manifest as { scenes?: unknown }).scenes;
  delete (manifest as { sceneOrder?: unknown }).sceneOrder;

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

  // Normalize every duck to `sidechainClipIds`. A duck used to name exactly ONE
  // sidechain, and manifests written then still say `sidechainClipId`; this is
  // the one read-time seam that turns it into `[id]`, which is why the change
  // to N sidechains needs no migration script. Runs on load so the preview, the
  // export and the tools all see the same shape.
  for (const clip of manifest.audioClips ?? []) {
    if (clip.duck) clip.duck = sanitizeDuck(clip.duck);
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

  // Warn — never rewrite — when a text overlay names a font family that will
  // not resolve (see lib/fonts/resolve.ts). Silently substituting a font is
  // how this bug hid in the first place: a whole 42-second piece rendered in
  // a serif fallback because it asked for "Inter", and nothing reported it
  // for twenty hours. This only reports; `font` is left byte-identical and a
  // bad family never makes the save throw.
  const textOverlays = (manifest.overlays ?? []).filter(
    (o): o is Extract<PersistedOverlay, { kind: "text" }> => o.kind === "text",
  );
  const badFamilies = unresolvedFamilies(textOverlays.map((o) => o.font));
  if (badFamilies.length > 0) {
    const badSet = new Set(badFamilies);
    const overlayIds = textOverlays
      .filter((o) => {
        const family = familyFromFont(o.font);
        return family !== null && badSet.has(family);
      })
      .map((o) => o.id);
    logger.child({ tag: "fonts", op: "unresolved_family" }).warn(
      { pieceId, families: badFamilies, overlayIds },
      "text overlay names a font family that will not resolve — it will render in a fallback face",
    );
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

  // Sweep any scene-*.json shard left by the retired canvas-scene layer.
  for (const entry of await storage.list(pieceId)) {
    if (entry.startsWith("scene-") && entry.endsWith(".json")) {
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

/** Load the full composition. Thin wrapper over `loadManifest`, kept because
 *  callers read as "load the composition" rather than "load a JSON file". */
export async function loadComposition(pieceId: string): Promise<{
  manifest: CompositionManifest;
}> {
  return { manifest: await loadManifest(pieceId) };
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
