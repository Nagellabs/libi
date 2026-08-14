/**
 * Pure factory for the create payload of a UI-added overlay. The returned
 * object is the body POSTed to /api/pieces/[pieceId]/overlays (the `add_overlay`
 * param shape MINUS pieceId, which the route injects from the URL). Rect is in
 * the composition's pixel space; the server `addOverlay` tool clamps it to the
 * frame on persist.
 */
export const DEFAULT_OVERLAY_DURATION = 3;

export type NewOverlayKind = "text" | "image" | "video";

export interface NewOverlayCtx {
  /** Playhead time in seconds (floored at 0). */
  startTime: number;
  /** Composition frame size. */
  width: number;
  height: number;
  /** Target z (caller passes maxZ + 1). */
  z: number;
  /** Composition duration in seconds — new overlays are clamped to never end
   *  past it (0/unknown ⇒ no clamp). */
  totalDuration: number;
  /** Required for image/video. */
  fileId?: string;
  /** Optional lane group to inherit (drag/inline paths pass this). */
  group?: string;
}

interface Rect { x: number; y: number; width: number; height: number }

/**
 * Place a new overlay so it always lies fully inside the timeline. A new overlay
 * must never start at/after the timeline end (it would never render). If the
 * desired start would push the overlay past the end, it is anchored to the END —
 * shifted back so it occupies the LAST `duration` seconds of the video. An
 * overlay can never be longer than the whole video. Pure; NO React/DOM.
 */
export function clampOverlayPlacement(args: {
  desiredStart: number;
  duration: number;
  totalDuration: number;
}): { startTime: number; duration: number } {
  const { desiredStart, duration, totalDuration } = args;
  // No timeline yet (or unknown) — keep the desired start, floored at 0.
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    return { startTime: Math.max(0, desiredStart), duration };
  }
  // An overlay can't be longer than the whole video.
  const dur = Math.min(Math.max(0, duration), totalDuration);
  // Anchor within [0, totalDuration]: a desired start past `end - dur` is pulled
  // back so the overlay ends exactly at the timeline end (the "last section").
  const startTime = Math.max(0, Math.min(desiredStart, totalDuration - dur));
  return { startTime, duration: dur };
}

export type NewOverlayPayload =
  | { kind: "text"; startTime: number; duration: number; z: number; rect: Rect; content: string; font: string; color: string; align: "left" | "center" | "right"; group?: string }
  | { kind: "image"; startTime: number; duration: number; z: number; rect: Rect; fileId: string; group?: string }
  | { kind: "video"; startTime: number; duration: number; z: number; rect: Rect; fileId: string; group?: string };

function centeredBox(width: number, height: number, frac: number): Rect {
  const w = width * frac;
  const h = height * frac;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

export function defaultOverlayInit(kind: NewOverlayKind, ctx: NewOverlayCtx): NewOverlayPayload {
  // Place the new overlay fully inside the timeline (never past the end; anchored
  // to the last section when the playhead is at/near the end).
  const { startTime, duration } = clampOverlayPlacement({
    desiredStart: ctx.startTime,
    duration: DEFAULT_OVERLAY_DURATION,
    totalDuration: ctx.totalDuration,
  });
  const base = { startTime, duration, z: ctx.z, ...(ctx.group ? { group: ctx.group } : {}) };

  if (kind === "text") {
    const w = ctx.width * 0.8;
    const h = ctx.height * 0.12;
    return {
      ...base,
      kind: "text",
      rect: { x: (ctx.width - w) / 2, y: ctx.height * 0.78, width: w, height: h },
      content: "New text",
      font: "48px Inter",
      color: "#ffffff",
      align: "center",
    };
  }
  if (!ctx.fileId) throw new Error(`defaultOverlayInit(${kind}) requires a fileId`);
  return { ...base, kind, rect: centeredBox(ctx.width, ctx.height, 0.4), fileId: ctx.fileId };
}
