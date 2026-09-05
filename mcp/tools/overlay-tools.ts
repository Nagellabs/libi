/** Overlay tool implementations (consolidated, file-based code). */

import {
  addOverlayToManifest,
  updateOverlayInManifest,
  removeOverlayFromManifest,
  reorderOverlaysInManifest,
  loadComposition,
  loadManifest,
  saveManifest,
  type PersistedOverlay,
} from "@/lib/composition/persistence";
import { pieceDurationSec } from "@/lib/composition/duration";
import {
  addClip,
  findInlineClipForOverlay,
  updateClip as updateClipPure,
} from "@/lib/composition/audio-clips";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { validateDrawFunction, validateThreeFunction, warnThreeFunction } from "@/lib/ai/scene-validator";
import { aspectMismatchWarning } from "@/lib/composition/aspect-mismatch";
import { findEffect, listEffects } from "@/lib/effects/registry";
import { overlayLogger } from "@/lib/logger";
import { clampRectToFrame } from "@/lib/engine/overlays";
import { flattenOverlay } from "@/lib/captions/flat-guard";
import { overlayCodeFile } from "@/lib/overlays/code-fields";
import { overlayCodeRelPath } from "@/lib/overlays/paths";
import { starterBody } from "@/lib/overlays/templates";
import {
  overlayKeyframeTimes,
  addKeyframeAt,
  deleteKeyframeAt,
  setSegmentEasing,
  allowedKeyframeProps,
  positionToRect,
  scaleRectAboutCenter,
  rotationDegToTransform,
  type KeyframeSnapshot,
} from "@/lib/overlays/keyframes";
import { resolveOverlayTransform } from "@/lib/engine/overlay-transform";
import { IDENTITY_TRANSFORM3D } from "@/lib/overlays/transform3d";
import { readWordsFromAnalysis } from "@/mcp/tools/caption-tools";
import { windowWordsToElementLocal } from "@/lib/captions/window";
import { EASING_PRESETS } from "@/lib/engine/easing-registry";
import type { Overlay, OverlayRect, Transform3D, OverlayKeyframes } from "@/lib/engine/types";
import type { ToolResult } from "./types";
import type {
  AddOverlayParams,
  UpdateOverlayParams,
  GetOverlaysParams,
  RemoveOverlayParams,
  ReorderOverlaysParams,
  AddKeyframeParams,
  DeleteKeyframeParams,
  SetKeyframeEasingParams,
  ListKeyframesParams,
} from "./schemas";

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).substring(2, 10)}`;
}

/** Look up a piece-scoped file row (or null). Mirrors video-scene-tools. */
function lookupPieceFile(pieceId: string, fileId: string) {
  const db = getDb();
  const [file] = db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.pieceId, pieceId)))
    .limit(1)
    .all();
  return file ?? null;
}

/**
 * Ownership gate for image/video overlay `fileId`s: the referenced file must be
 * in the piece's files ∪ global files (`pieceId` null) — the same membership
 * `buildComposition` encodes in `knownFileIds` when it flags an overlay
 * `missing`. Without this gate an agent could persist an overlay pointing at
 * ANOTHER piece's file: the preview then renders a permanent "Media file
 * missing" placeholder, and (pre-strip-fix) a parked video decoder re-buffered
 * playback every ~1s. Returns a structured rejection ToolResult, or null when
 * the fileId is usable.
 */
function validateOverlayFileId(pieceId: string, fileId: string): ToolResult | null {
  const db = getDb();
  const [file] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!file) {
    return {
      success: false,
      error: "file_not_found",
      data: {
        hint: `No file with id ${fileId} exists. Use libi.list_files({ pieceId }) to see this piece's files.`,
      },
    };
  }
  if (file.pieceId != null && file.pieceId !== pieceId) {
    return {
      success: false,
      error: "file_not_in_piece",
      data: {
        hint: `File ${fileId} belongs to another piece (${file.pieceId}) — use libi.duplicate_file or libi.assign_file to bring it into this piece first.`,
      },
    };
  }
  return null;
}

/** The canonical flip + group fields, copied straight from add params. NOTE:
 *  `rotation` (degrees) is deliberately NOT copied here — it is INPUT SUGAR that
 *  the handler converts to `transform3d.rotation.z` (the single rotation
 *  authority); there is no legacy `rotation` storage field. */
function transformFields(
  p: { flipH?: boolean; flipV?: boolean; group?: string },
): { flipH?: boolean; flipV?: boolean; group?: string } {
  const out: { flipH?: boolean; flipV?: boolean; group?: string } = {};
  if (p.flipH !== undefined) out.flipH = p.flipH;
  if (p.flipV !== undefined) out.flipV = p.flipV;
  if (p.group !== undefined) out.group = p.group;
  return out;
}

/**
 * Optional caption-styling + reveal fields (Milestone 3), copied straight from
 * the text add params. Only present keys are emitted, so the persisted overlay
 * never carries `undefined` styling.
 */
function captionStyleFields(p: {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
  lineHeight?: number;
  background?: unknown;
  stroke?: unknown;
  shadow?: unknown;
  reveal?: unknown;
  threeD?: unknown;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.fontFamily !== undefined) out.fontFamily = p.fontFamily;
  if (p.fontSize !== undefined) out.fontSize = p.fontSize;
  if (p.fontWeight !== undefined) out.fontWeight = p.fontWeight;
  if (p.lineHeight !== undefined) out.lineHeight = p.lineHeight;
  if (p.background !== undefined) out.background = p.background;
  if (p.stroke !== undefined) out.stroke = p.stroke;
  if (p.shadow !== undefined) out.shadow = p.shadow;
  if (p.reveal !== undefined) out.reveal = p.reveal;
  if (p.threeD !== undefined) out.threeD = p.threeD;
  return out;
}

/** Clamp a 2D overlay rect to the piece's frame bounds (no-op on load failure). */
async function clampRect(pieceId: string, rect: OverlayRect): Promise<OverlayRect> {
  const frame = await loadFrame(pieceId);
  return clampToFrame(frame, rect);
}

/**
 * The composition's frame size, read ONCE per add.
 *
 * `addOverlay` needs the frame up to three times — to clamp the supplied rect,
 * to default a video overlay to full-frame, and to compare the source's aspect
 * against the canvas. Each used to load the manifest separately. They all
 * describe the same frame within one request, so one read is both cheaper and
 * more obviously consistent.
 *
 * Returns null when the manifest cannot be read; callers then leave the rect
 * untouched rather than clamping against a guessed frame.
 */
async function loadFrame(pieceId: string): Promise<{ width: number; height: number } | null> {
  try {
    const { manifest } = await loadComposition(pieceId);
    return { width: manifest.width, height: manifest.height };
  } catch {
    return null;
  }
}

/** Pure clamp against an already-loaded frame. */
function clampToFrame(
  frame: { width: number; height: number } | null,
  rect: OverlayRect,
): OverlayRect {
  return frame ? clampRectToFrame(rect, frame.width, frame.height) : rect;
}

/** codeFilePath for the data payload, or undefined for non-code overlays. */
function codePathFor(o: PersistedOverlay): string | undefined {
  const f = overlayCodeFile(o);
  return f ? overlayCodeRelPath(o.id, f) : undefined;
}

/**
 * add_overlay — create an overlay of any kind. For `code`/`three`, the body
 * (or a scaffolded starter when omitted) is validated, then persisted to a
 * per-overlay file via the persistence seam; the returned `codeFilePath` is
 * the file the agent edits directly with its file tools.
 */
export async function addOverlay(params: AddOverlayParams): Promise<ToolResult> {
  const { pieceId, kind } = params;
  let overlay: PersistedOverlay;

  // Per-kind required fields (the flat schema can't express this without a
  // refine, which would break MCP schema serialization — see schemas.ts).
  if (kind === "text" && params.content === undefined) {
    return {
      success: false,
      error: "missing_field",
      data: { hint: "A text overlay requires `content`." },
    };
  }
  if ((kind === "image" || kind === "video") && params.fileId === undefined) {
    return {
      success: false,
      error: "missing_field",
      data: { hint: `A ${kind} overlay requires \`fileId\`.` },
    };
  }
  // Reject a fileId the piece can't actually use (unknown, or owned by another
  // piece) BEFORE anything is persisted — see validateOverlayFileId.
  if ((kind === "image" || kind === "video") && params.fileId !== undefined) {
    const rejection = validateOverlayFileId(pieceId, params.fileId);
    if (rejection) {
      overlayLogger.warn(
        { event: "add_rejected_file_id", pieceId, kind, fileId: params.fileId, reason: rejection.error },
        "overlay.add rejected — fileId not usable by this piece",
      );
      return rejection;
    }
  }
  // `rect` is optional in the schema only so a VIDEO overlay can default to the
  // full composition frame. Every other kind still requires one.
  if (kind !== "video" && params.rect === undefined) {
    return {
      success: false,
      error: "missing_field",
      data: { hint: `A ${kind} overlay requires \`rect\`.` },
    };
  }
  // code/three carry no inherent label (no text/file), so a displayName is
  // MANDATORY at creation — it's what identifies the track in the timeline.
  if ((kind === "code" || kind === "three") && !params.displayName?.trim()) {
    return {
      success: false,
      error: "missing_field",
      data: {
        hint: `A ${kind} overlay requires a \`displayName\` (shown in the timeline track label, e.g. "Intro Title").`,
      },
    };
  }

  // One read of the frame for this whole add — the clamp, the video full-frame
  // default and the aspect-mismatch check all describe the same canvas.
  const frame = await loadFrame(pieceId);

  if (kind === "text") {
    overlay = {
      id: newId("text"),
      kind,
      startTime: params.startTime,
      duration: params.duration,
      rect: clampToFrame(frame, params.rect!),
      z: params.z,
      opacity: params.opacity,
      content: params.content!,
      // Defaults applied here (the schema keeps font/color/align optional so the
      // inferred type doesn't force them onto non-text overlays — see schemas.ts).
      font: params.font ?? "48px Inter",
      color: params.color ?? "#ffffff",
      align: params.align ?? "center",
      ...(params.fontFileId ? { fontFileId: params.fontFileId } : {}),
      ...captionStyleFields(params),
      ...transformFields(params),
    };
  } else if (kind === "image") {
    overlay = {
      id: newId("img"),
      kind,
      startTime: params.startTime,
      duration: params.duration,
      rect: clampToFrame(frame, params.rect!),
      z: params.z,
      opacity: params.opacity,
      fileId: params.fileId!,
      ...transformFields(params),
    };
  } else if (kind === "video") {
    // Same rule as audioAddClip — see mcp/tools/audio-clip-tools.ts. Video only:
    // a text/image/code/three overlay has no intrinsic asset length, so there is
    // nothing to trade off. `duration` is required on this tool, so unlike the
    // audio gate an explicit duration cannot mean "already decided" — the policy
    // param is the only way through.
    let videoDuration = params.duration;
    const manifest = await loadManifest(pieceId);
    const pieceEnd = pieceDurationSec(manifest);
    const wouldExceed = pieceEnd > 0 && params.startTime + params.duration > pieceEnd;
    if (wouldExceed) {
      if (!params.lengthPolicy) {
        return {
          success: false,
          error: "asset_longer_than_piece",
          data: {
            assetDurationSec: params.duration,
            pieceDurationSec: pieceEnd,
            message:
              `This overlay would run to ${params.startTime + params.duration}s but the piece is ` +
              `currently ${pieceEnd}s. Ask the user whether to extend the piece, trim the overlay ` +
              "to the piece's length, or use a specific length, then call again with lengthPolicy.",
          },
        };
      }
      if (params.lengthPolicy === "trim") {
        videoDuration = Math.max(0, pieceEnd - params.startTime);
      }
    }

    // A video overlay defaults to the FULL composition frame + fit:"cover" when
    // no rect is supplied — it reads like a base scene (fills the frame,
    // croppable). An explicit rect is clamped + uses the supplied fit
    // (default "cover").
    let rect: OverlayRect;
    if (params.rect === undefined) {
      // Throwing matches the old behaviour exactly: this branch used to call
      // loadComposition directly and let a read failure propagate to the
      // tool's error result. There is no safe frame to default to.
      if (!frame) throw new Error(`Could not read the composition for piece ${pieceId}`);
      rect = { x: 0, y: 0, width: frame.width, height: frame.height };
    } else {
      rect = clampToFrame(frame, params.rect);
    }
    overlay = {
      id: newId("vid"),
      kind,
      startTime: params.startTime,
      duration: videoDuration,
      rect,
      z: params.z,
      opacity: params.opacity,
      fileId: params.fileId!,
      trim: params.trim,
      fit: params.fit ?? "cover",
      ...transformFields(params),
    };
  } else if (kind === "code") {
    const body = params.body ?? starterBody("code");
    const validation = validateDrawFunction(body);
    if (!validation.valid) {
      overlayLogger.warn(
        { pieceId, reason: validation.error },
        "overlay.add rejected — invalid code overlay draw function",
      );
      return { success: false, error: validation.error };
    }
    overlay = {
      id: newId("code"),
      kind,
      startTime: params.startTime,
      duration: params.duration,
      rect: clampToFrame(frame, params.rect!),
      z: params.z,
      opacity: params.opacity,
      drawFunction: body,
      ...transformFields(params),
    };
  } else {
    // three — NOT rect-clamped; projected 3D size depends on the camera.
    const body = params.body ?? starterBody("three");
    const validation = validateThreeFunction(body);
    if (!validation.valid) {
      overlayLogger.warn(
        { pieceId, reason: validation.error },
        "overlay.add rejected — invalid three scene function",
      );
      return { success: false, error: validation.error };
    }
    overlay = {
      id: newId("three"),
      kind,
      startTime: params.startTime,
      duration: params.duration,
      rect: params.rect!,
      z: params.z,
      opacity: params.opacity,
      sceneFunction: body,
      cameraPreset: params.cameraPreset,
      ...(params.transform3d !== undefined ? { transform3d: params.transform3d } : {}),
      ...transformFields(params),
    };
  }

  // Attach the agent-set display name (validated mandatory for code/three above;
  // optional elsewhere). Trimmed so a stray-whitespace name doesn't persist.
  if (params.displayName?.trim()) {
    (overlay as { displayName?: string }).displayName = params.displayName.trim();
  }

  if (params.effects) {
    // Reject any unknown effectId up-front — don't persist a dangling effect.
    const refs = [params.effects.in, params.effects.out, params.effects.loop].filter(
      Boolean,
    ) as { effectId: string }[];
    for (const r of refs) {
      if (!findEffect(r.effectId)) {
        return {
          success: false,
          error: "unknown_effect",
          data: {
            hint: `Unknown effectId "${r.effectId}". Call libi.list_effects.`,
            validIds: listEffects().map((e) => e.meta.id),
          },
        };
      }
    }
    (overlay as { effects?: typeof params.effects }).effects = params.effects;
  }

  // `rotation` (degrees) is INPUT SUGAR: storage has a single rotation authority
  // (transform3d.rotation.z, radians). Merge it onto the effective transform3d so
  // no legacy `rotation` field is ever persisted.
  if (typeof params.rotation === "number") {
    const base = resolveOverlayTransform(overlay as Overlay);
    (overlay as { transform3d?: Transform3D }).transform3d = rotationDegToTransform(
      base,
      params.rotation % 360,
    );
  }

  await addOverlayToManifest(pieceId, overlay);
  overlayLogger.info({ event: "add", pieceId, overlayId: overlay.id, kind }, "overlay.add");

  // Auto-create the linked inline AudioClip when a VIDEO overlay's source has
  // audio — mirrors the video-scene path so a video overlay isn't silent.
  // Idempotent via findInlineClipForOverlay. (file-tools' upload route checks
  // hasAudio the same way.)
  if (overlay.kind === "video") {
    const file = lookupPieceFile(pieceId, overlay.fileId);
    if (file?.hasAudio) {
      const manifest = await loadManifest(pieceId);
      if (!findInlineClipForOverlay(manifest, overlay.id)) {
        const next = addClip(manifest, {
          id: `clip_${Math.random().toString(36).substring(2, 10)}`,
          kind: "inline",
          fileId: overlay.fileId,
          startTime: overlay.startTime,
          duration: overlay.duration,
          trimStart: overlay.trim?.start ?? 0,
          volume: 1,
          enabled: true,
          linkedOverlayId: overlay.id,
        });
        await saveManifest(pieceId, next);
        overlayLogger.info(
          { event: "add_inline_audio", pieceId, overlayId: overlay.id, fileId: overlay.fileId },
          "overlay.add — auto-created linked inline audio",
        );
      }
    }
  }

  const codeFilePath = codePathFor(overlay);

  const warnings: string[] = [];
  const threeWarning =
    overlay.kind === "three" ? warnThreeFunction(overlay.sceneFunction) : null;
  if (threeWarning) {
    warnings.push(threeWarning);
    overlayLogger.warn(
      { pieceId, overlayId: overlay.id, warning: threeWarning },
      "overlay.add three — resource-budget warning",
    );
  }

  if (overlay.kind === "video" || overlay.kind === "image") {
    const mediaFile = lookupPieceFile(pieceId, overlay.fileId);
    const mismatch = aspectMismatchWarning({
      compWidth: frame?.width ?? 0,
      compHeight: frame?.height ?? 0,
      mediaWidth: mediaFile?.mediaWidth ?? null,
      mediaHeight: mediaFile?.mediaHeight ?? null,
      rect: overlay.rect,
    });
    if (mismatch) {
      warnings.push(mismatch);
      overlayLogger.warn(
        { pieceId, overlayId: overlay.id, kind: overlay.kind },
        "overlay.add — full-frame source does not match the composition aspect",
      );
    }
  }

  return {
    success: true,
    data: {
      overlayId: overlay.id,
      ...(codeFilePath ? { codeFilePath } : {}),
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    },
  };
}

/**
 * update_overlay — change STRUCTURED fields only (timing, rect, z, opacity,
 * text content/font/color/align, three cameraPreset). Never touches code; the
 * agent edits code/scene/content files directly.
 */
export async function updateOverlay(params: UpdateOverlayParams): Promise<ToolResult> {
  const { pieceId, overlayId, ...patch } = params;
  const cleanPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) cleanPatch[k] = v;
  }
  if (cleanPatch.rect) cleanPatch.rect = await clampRect(pieceId, cleanPatch.rect as OverlayRect);
  // Ownership gate for a fileId patch (defensive — the MCP/REST schemas don't
  // expose `fileId` today, but this function is called directly elsewhere and
  // the schema may grow one): reject an unknown or cross-piece fileId before
  // it is persisted, exactly like add_overlay.
  if (typeof cleanPatch.fileId === "string") {
    const rejection = validateOverlayFileId(pieceId, cleanPatch.fileId);
    if (rejection) {
      overlayLogger.warn(
        { event: "update_rejected_file_id", pieceId, overlayId, fileId: cleanPatch.fileId, reason: rejection.error },
        "overlay.update rejected — fileId not usable by this piece",
      );
      return rejection;
    }
  }
  // `rotation` (degrees) is INPUT SUGAR: storage has a single rotation authority
  // (transform3d.rotation.z, radians). Merge it into the effective transform3d —
  // an explicit transform3d in the same patch wins as the base, else the current
  // overlay's transform3d. There is no legacy `rotation` storage field.
  if (typeof cleanPatch.rotation === "number") {
    const deg = cleanPatch.rotation as number;
    delete cleanPatch.rotation;
    const explicit = cleanPatch.transform3d as Transform3D | undefined;
    const base =
      explicit ??
      (await (async () => {
        const { manifest } = await loadComposition(pieceId);
        const cur = (manifest.overlays ?? []).find((o) => o.id === overlayId) as
          | Overlay
          | undefined;
        return cur ? resolveOverlayTransform(cur) : IDENTITY_TRANSFORM3D;
      })());
    cleanPatch.transform3d = rotationDegToTransform(base, deg % 360);
  }
  // Turning "Make it 3D" OFF force-flattens: load the current overlay, run the
  // shared flatten (zeros pitch/yaw + depth, drops text extrusion), and write
  // through the resulting fields so the persisted overlay truly returns to 2D.
  if (cleanPatch.place3d === false) {
    const { manifest } = await loadComposition(pieceId);
    const current = (manifest.overlays ?? []).find((o) => o.id === overlayId) as
      | Overlay
      | undefined;
    if (current) {
      const flat = flattenOverlay(current);
      cleanPatch.transform3d = flat.transform3d;
      // `threeD` lives only on text overlays; `null` is the delete sentinel.
      if (current.kind === "text") cleanPatch.threeD = null;
    }
  }
  // Attach a source file's transcript word-timings to this overlay (any kind —
  // esp. a custom code/three caption). Transcript = source of truth; the derived,
  // element-local snapshot is stored as `caption.words` so the body voice-syncs
  // via the injected helpers instead of embedding timings. `captionFromFileId` is
  // a directive, not a stored field — resolve it, then drop it from the patch.
  if (typeof cleanPatch.captionFromFileId === "string") {
    const fileId = cleanPatch.captionFromFileId;
    delete cleanPatch.captionFromFileId;
    const { manifest } = await loadComposition(pieceId);
    const current = (manifest.overlays ?? []).find((o) => o.id === overlayId) as
      | Overlay
      | undefined;
    const startTime = (cleanPatch.startTime as number | undefined) ?? current?.startTime ?? 0;
    const duration = (cleanPatch.duration as number | undefined) ?? current?.duration ?? 0;
    const abs = await readWordsFromAnalysis(fileId);
    const words = windowWordsToElementLocal(abs, startTime, duration);
    if (words.length === 0) {
      return {
        success: false,
        error: "no_transcript_in_window",
        data: {
          hint: `No spoken words from file ${fileId} overlap this overlay's window (${startTime.toFixed(2)}s–${(startTime + duration).toFixed(2)}s). Transcribe the file first (audio-analysis) or check the overlay's timing.`,
        },
      };
    }
    cleanPatch.caption = {
      groupId: `cap-${fileId}-custom`,
      useTrackStyle: false,
      words,
    };
  }

  const ok = await updateOverlayInManifest(pieceId, overlayId, cleanPatch as never);
  if (!ok) {
    overlayLogger.warn({ pieceId, overlayId }, "overlay.update miss — id not found");
    return { success: false, error: `overlay ${overlayId} not found` };
  }

  // Keep a video overlay's linked inline audio clip in lock-step: re-timing or
  // re-trimming the overlay moves/retrims its audio too. trim.start drives
  // trimStart; startTime/duration map 1:1.
  const retimes =
    cleanPatch.startTime !== undefined ||
    cleanPatch.duration !== undefined ||
    cleanPatch.trim !== undefined;
  if (retimes) {
    const manifest = await loadManifest(pieceId);
    const clip = findInlineClipForOverlay(manifest, overlayId);
    if (clip) {
      const clipPatch: Record<string, unknown> = {};
      if (cleanPatch.startTime !== undefined) clipPatch.startTime = cleanPatch.startTime;
      if (cleanPatch.duration !== undefined) clipPatch.duration = cleanPatch.duration;
      if (cleanPatch.trim !== undefined) {
        clipPatch.trimStart = (cleanPatch.trim as { start: number }).start;
      }
      if (Object.keys(clipPatch).length > 0) {
        const next = updateClipPure(manifest, clip.id, clipPatch);
        if (next) await saveManifest(pieceId, next);
      }
    }
  }

  overlayLogger.info(
    { event: "update", pieceId, overlayId, patchFields: Object.keys(cleanPatch) },
    "overlay.update",
  );
  return { success: true, data: { overlayId } };
}

/**
 * get_overlays — list overlay records for a piece. Code-bearing overlays
 * (code/three/tracked-code) carry a `codeFilePath` instead of the (large)
 * hydrated body; the agent reads/edits that file directly.
 */
export async function getOverlays(params: GetOverlaysParams): Promise<ToolResult> {
  const { manifest } = await loadComposition(params.pieceId);
  const overlays = (manifest.overlays ?? []).map((o) => {
    const codeFilePath = codePathFor(o);
    // Strip the (large) hydrated body fields; agents edit the file.
    const { drawFunction, sceneFunction, content, ...rest } = o as Record<string, unknown>;
    // Tracked-code overlays nest the body at content.drawFunction — elide it too.
    const strippedContent =
      content && typeof content === "object" && (content as Record<string, unknown>).kind === "code"
        ? (() => {
            const { drawFunction: _drop, ...contentRest } = content as Record<string, unknown>;
            return { ...contentRest };
          })()
        : content;
    return {
      ...rest,
      ...(content !== undefined ? { content: strippedContent } : {}),
      ...(codeFilePath ? { codeFilePath } : {}),
    };
  });
  return { success: true, data: { overlays } };
}

export async function removeOverlayTool(params: RemoveOverlayParams): Promise<ToolResult> {
  const ok = await removeOverlayFromManifest(params.pieceId, params.overlayId);
  if (!ok) {
    overlayLogger.warn(
      { pieceId: params.pieceId, overlayId: params.overlayId },
      "overlay.remove miss",
    );
    return { success: false, error: `overlay ${params.overlayId} not found` };
  }
  overlayLogger.info(
    { event: "remove", pieceId: params.pieceId, overlayId: params.overlayId },
    "overlay.remove",
  );
  return { success: true };
}

export async function reorderOverlays(params: ReorderOverlaysParams): Promise<ToolResult> {
  await reorderOverlaysInManifest(params.pieceId, params.overlayIdsInZOrder);
  overlayLogger.info(
    { event: "reorder", pieceId: params.pieceId, count: params.overlayIdsInZOrder.length },
    "overlay.reorder",
  );
  return { success: true };
}

// ---------------------------------------------------------------------------
// Overlay keyframe animation (Phase 4 — agent authoring)
// ---------------------------------------------------------------------------
// Callers speak SECONDS (wall-clock within the clip); the keyframe store is
// NORMALIZED (t ∈ [0,1]). These handlers convert, then delegate to the pure
// helpers in lib/overlays/keyframes.ts and write via updateOverlayInManifest.

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Load one overlay from the (hydrated) manifest, or null. */
async function loadOverlay(pieceId: string, overlayId: string): Promise<Overlay | null> {
  const { manifest } = await loadComposition(pieceId);
  const found = (manifest.overlays ?? []).find((o) => o.id === overlayId);
  return (found as Overlay | undefined) ?? null;
}

/** Seconds → normalized t within the overlay window. Null when duration ≤ 0. */
function secondsToNormalized(overlay: Overlay, seconds: number): number | null {
  if (!(overlay.duration > 0)) return null;
  if (seconds < 0 || seconds > overlay.duration) return null;
  return clamp01(seconds / overlay.duration);
}

const KNOWN_EASING_IDS = new Set(EASING_PRESETS.map((p) => p.id));
const CUBIC_BEZIER_RE = /^cubic-bezier\(\s*([^)]+)\s*\)$/i;

/** True when `easing` is a known preset id OR a well-formed cubic-bezier(...). */
function isValidEasing(easing: string): boolean {
  if (KNOWN_EASING_IDS.has(easing)) return true;
  const m = CUBIC_BEZIER_RE.exec(easing.trim());
  if (!m) return false;
  const parts = m[1].split(",").map((s) => Number(s.trim()));
  return parts.length === 4 && parts.every((n) => Number.isFinite(n));
}

/**
 * Translate the flat `properties` object into a `Partial<KeyframeSnapshot>`
 * (rect / opacity / transform3d values) using the overlay's BASE fields as the
 * template. Tracked overlays (D9) honor OPACITY only; other props are dropped
 * and reported back to the caller via `dropped`.
 */
function mapProperties(
  overlay: Overlay,
  props: NonNullable<AddKeyframeParams["properties"]>,
): { snap: Partial<KeyframeSnapshot>; dropped: string[] } {
  const allowed = new Set(allowedKeyframeProps(overlay.kind));
  const dropped: string[] = [];
  const snap: Partial<KeyframeSnapshot> = {};

  const baseRect = overlay.rect;
  const baseTransform = resolveOverlayTransform(overlay);

  // opacity — always allowed on every kind.
  if (props.opacity !== undefined) snap.opacity = props.opacity;

  // position → rect track (keep base w/h).
  if (props.position !== undefined) {
    if (allowed.has("rect")) {
      snap.rect = positionToRect(baseRect, props.position);
    } else {
      dropped.push("position");
    }
  }

  // scale → rect track (scale about the rect center).
  if (props.scale !== undefined) {
    if (allowed.has("rect")) {
      snap.rect = scaleRectAboutCenter(baseRect, props.scale);
    } else {
      dropped.push("scale");
    }
  }

  // explicit rect → rect track (passthrough, wins over position/scale).
  if (props.rect !== undefined) {
    if (allowed.has("rect")) snap.rect = props.rect;
    else dropped.push("rect");
  }

  // rotation (degrees) → transform3d track (screen-roll on rotation.z).
  if (props.rotation !== undefined) {
    if (allowed.has("transform3d")) {
      snap.transform3d = rotationDegToTransform(baseTransform, props.rotation);
    } else {
      dropped.push("rotation");
    }
  }

  // explicit transform3d → transform3d track (passthrough).
  if (props.transform3d !== undefined) {
    if (allowed.has("transform3d")) snap.transform3d = props.transform3d as Transform3D;
    else dropped.push("transform3d");
  }

  return { snap, dropped };
}

/**
 * add_keyframe — insert/replace a keyframe at `time` (seconds). When
 * `properties` is omitted, snapshots ALL allowed properties; otherwise keys the
 * named subset (D9: tracked ⇒ opacity only). Optional `easing` sets the
 * outgoing-segment curve on the same keyframe.
 */
export async function addKeyframe(params: AddKeyframeParams): Promise<ToolResult> {
  const { pieceId, overlayId, time, properties, easing } = params;
  // Load the composition (not just the overlay) so we have the fps needed to
  // frame-quantize the keyframe time + size the snap tolerance.
  const { manifest } = await loadComposition(pieceId);
  const overlay =
    ((manifest.overlays ?? []).find((o) => o.id === overlayId) as Overlay | undefined) ?? null;
  if (!overlay) return { success: false, error: `overlay ${overlayId} not found` };

  const tRaw = secondsToNormalized(overlay, time);
  if (tRaw === null) {
    return {
      success: false,
      error: `time ${time}s is out of range for overlay window [0, ${overlay.duration}]s`,
    };
  }

  // Frame-quantize the keyframe time and match existing keyframes within HALF a
  // frame (the CapCut "same frame overwrites" model): an edit landing near an
  // existing keyframe UPDATES it rather than dropping a near-duplicate a hair
  // away — the root cause of "editing a keyframe just makes another one".
  const fps = manifest.fps > 0 ? manifest.fps : 30;
  const totalFrames = overlay.duration * fps;
  const t = totalFrames > 0 ? Math.round(tRaw * totalFrames) / totalFrames : tRaw;
  const tolerance = totalFrames > 0 ? 0.5 / totalFrames : 0;
  // The `t` the write will actually land on: a nearby existing keyframe keeps
  // ITS time (snap), so easing/logging must target that, not the quantized `t`.
  const nearExisting = overlayKeyframeTimes(overlay).reduce<number | null>(
    (best, kt) =>
      Math.abs(kt - t) <= tolerance &&
      (best === null || Math.abs(kt - t) < Math.abs(best - t))
        ? kt
        : best,
    null,
  );
  const effectiveT = nearExisting ?? t;

  let dropped: string[] = [];
  let patch: { keyframes: OverlayKeyframes };
  if (properties === undefined) {
    // Snapshot ALL allowed props at t.
    patch = addKeyframeAt(overlay, t, undefined, tolerance);
  } else {
    const mapped = mapProperties(overlay, properties);
    dropped = mapped.dropped;
    if (Object.keys(mapped.snap).length === 0) {
      return {
        success: false,
        error:
          dropped.length > 0
            ? `no keyable properties for a ${overlay.kind} overlay (dropped: ${dropped.join(", ")})`
            : "no properties supplied to key",
      };
    }
    patch = addKeyframeAt(overlay, t, mapped.snap, tolerance);
  }

  // Apply the patch, then optionally the segment easing on the landed keyframe
  // (needs the keyframe to already exist, so re-derive from the patched keys).
  let keyframes = patch.keyframes;
  if (easing !== undefined) {
    if (!isValidEasing(easing)) {
      return { success: false, error: `invalid easing "${easing}"` };
    }
    const easedPatch = setSegmentEasing({ ...overlay, keyframes } as Overlay, effectiveT, easing);
    keyframes = easedPatch.keyframes;
  }

  const ok = await updateOverlayInManifest(pieceId, overlayId, { keyframes } as never);
  if (!ok) return { success: false, error: `overlay ${overlayId} not found` };

  overlayLogger.info(
    { event: "keyframe_add", pieceId, overlayId, t: effectiveT, dropped },
    "overlay.keyframe.add",
  );
  return {
    success: true,
    data: { overlayId, time, t: effectiveT, ...(dropped.length > 0 ? { dropped } : {}) },
  };
}

/**
 * delete_keyframe — remove the keyframe at `time` (seconds) across every track.
 * A track left with <2 keys collapses to constant (handled in the helper); when
 * no track survives the whole `keyframes` field is cleared (null sentinel).
 */
export async function deleteKeyframe(params: DeleteKeyframeParams): Promise<ToolResult> {
  const { pieceId, overlayId, time } = params;
  const overlay = await loadOverlay(pieceId, overlayId);
  if (!overlay) return { success: false, error: `overlay ${overlayId} not found` };

  const t = secondsToNormalized(overlay, time);
  if (t === null) {
    return {
      success: false,
      error: `time ${time}s is out of range for overlay window [0, ${overlay.duration}]s`,
    };
  }

  // Resolve to the nearest STORED keyframe time (tolerating float round-trip
  // drift from seconds↔normalized) and delete THAT — so a request that lands a
  // hair off a stored `t` can't silently no-op yet return success. No keyframe
  // within tolerance ⇒ a structured error, not a false success.
  const times = overlayKeyframeTimes(overlay);
  const nearest =
    times.length > 0
      ? times.reduce((best, kt) => (Math.abs(kt - t) < Math.abs(best - t) ? kt : best), times[0])
      : null;
  if (nearest === null || Math.abs(nearest - t) > 1e-6) {
    return { success: false, error: `no keyframe at ${time}s` };
  }

  const patch = deleteKeyframeAt(overlay, nearest);
  const ok = await updateOverlayInManifest(pieceId, overlayId, patch as never);
  if (!ok) return { success: false, error: `overlay ${overlayId} not found` };

  overlayLogger.info(
    { event: "keyframe_delete", pieceId, overlayId, t: nearest, cleared: patch.keyframes === null },
    "overlay.keyframe.delete",
  );
  return { success: true, data: { overlayId, time, t: nearest } };
}

/**
 * clear_keyframes — drop the WHOLE `keyframes` field so every animatable
 * property becomes constant again (the base field). ROUTE-ONLY: consumed by the
 * timeline "Clear all keyframes" action via DELETE ?all=1; it is intentionally
 * NOT registered in mcp/server.ts (the agent clears via delete_keyframe or by
 * omitting tracks). Idempotent: an overlay with no keyframes returns success
 * (writes the null sentinel, a no-op on the manifest).
 */
export async function clearKeyframes(params: {
  pieceId: string;
  overlayId: string;
}): Promise<ToolResult> {
  const { pieceId, overlayId } = params;
  const overlay = await loadOverlay(pieceId, overlayId);
  if (!overlay) return { success: false, error: `overlay ${overlayId} not found` };

  const ok = await updateOverlayInManifest(pieceId, overlayId, { keyframes: null } as never);
  if (!ok) return { success: false, error: `overlay ${overlayId} not found` };

  overlayLogger.info(
    { event: "keyframe_clear_all", pieceId, overlayId },
    "overlay.keyframe.clear_all",
  );
  return { success: true, data: { overlayId, cleared: true } };
}

/**
 * set_keyframe_easing — set the OUTGOING-segment easing (D3: stored on the left
 * keyframe) for the keyframe at `time` (seconds). Rejects clearly-invalid easing.
 */
export async function setKeyframeEasing(params: SetKeyframeEasingParams): Promise<ToolResult> {
  const { pieceId, overlayId, time, easing } = params;
  if (!isValidEasing(easing)) {
    return { success: false, error: `invalid easing "${easing}"` };
  }
  const overlay = await loadOverlay(pieceId, overlayId);
  if (!overlay) return { success: false, error: `overlay ${overlayId} not found` };

  const t = secondsToNormalized(overlay, time);
  if (t === null) {
    return {
      success: false,
      error: `time ${time}s is out of range for overlay window [0, ${overlay.duration}]s`,
    };
  }

  // No-op guard: setSegmentEasing silently no-ops when no track has a key at
  // `t`. Detect that and surface a structured error instead of a false success.
  const hasKeyAtT = overlayKeyframeTimes(overlay).some((kt) => kt === t);
  if (!hasKeyAtT) {
    return { success: false, error: `no keyframe at ${time}s` };
  }

  const patch = setSegmentEasing(overlay, t, easing);
  const ok = await updateOverlayInManifest(pieceId, overlayId, patch as never);
  if (!ok) return { success: false, error: `overlay ${overlayId} not found` };

  overlayLogger.info(
    { event: "keyframe_easing", pieceId, overlayId, t, easing },
    "overlay.keyframe.easing",
  );
  return { success: true, data: { overlayId, time, t, easing } };
}

/**
 * list_keyframes — the per-track keyframe list + the unified time list, all in
 * SECONDS (the stored normalized t is converted back via t * duration).
 */
export async function listKeyframes(params: ListKeyframesParams): Promise<ToolResult> {
  const { pieceId, overlayId } = params;
  const overlay = await loadOverlay(pieceId, overlayId);
  if (!overlay) return { success: false, error: `overlay ${overlayId} not found` };

  const duration = overlay.duration;
  const toSec = (t: number) => t * duration;

  const times = overlayKeyframeTimes(overlay).map(toSec);

  const kf = overlay.keyframes;
  const trackOf = (track?: { keyframes: { t: number; easing?: string }[] }) =>
    track
      ? track.keyframes.map((k) => ({
          time: toSec(k.t),
          ...(k.easing !== undefined ? { easing: k.easing } : {}),
        }))
      : undefined;

  const tracks: Record<string, { time: number; easing?: string }[]> = {};
  const rect = trackOf(kf?.rect);
  const opacity = trackOf(kf?.opacity);
  const transform3d = trackOf(kf?.transform3d);
  if (rect) tracks.rect = rect;
  if (opacity) tracks.opacity = opacity;
  if (transform3d) tracks.transform3d = transform3d;

  return { success: true, data: { overlayId, duration, times, tracks } };
}
