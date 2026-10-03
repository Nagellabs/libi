/**
 * Reflow: lay a template's layers out again for a frame of another shape.
 *
 * A template is authored for one canvas (1920×1080, say) and applied to a piece
 * of another (1080×1920). Left as authored, every layer sits at its old pixels:
 * a title centred on a landscape frame hangs off the side of a portrait one, and
 * the agent spends a call per layer putting it back. Reflow does that placement:
 *
 * - **Scale** is the ratio of the short sides (a type size means the same thing
 *   to the eye on both frames when it follows the short side).
 * - **Anchor**: on each axis a rect is read as pinned to the near edge, the far
 *   edge or the centre (whichever it is closest to), and keeps its scaled
 *   distance from THAT in the new frame. A rect that spans a whole axis (a
 *   backdrop, a full-width band) spans the new frame's axis instead.
 * - **Safe area**: a layer that would not fit inside 5 % margins is scaled
 *   down uniformly until it does, then kept inside; a layer that already ran to
 *   the edge keeps hugging it.
 * - **Type** follows the layer's scale: font size (and the `font` shorthand's
 *   px), stroke / shadow / plate sizes, the wrap width and a point-text
 *   position.
 * - **Keyframed rects** travel with their overlay (lib/overlays/keyframe-follow.ts);
 *   a 3D offset scales with it.
 *
 * Pure: no IO, no clock. The apply (lib/templates/materialize.ts) runs it over
 * each layer and surfaces what could not be placed as warnings.
 */
import type { OverlayKeyframes, OverlayRect, Transform3D } from "@/lib/engine/types";
import { followRectKeyframes, scaleTransformOffset } from "@/lib/overlays/keyframe-follow";

export interface ReflowFrame {
  width: number;
  height: number;
}

/** Margin kept clear on every side, as a fraction of the frame. */
export const REFLOW_SAFE_MARGIN = 0.05;
/** The widest a text layer's wrap may become, as a fraction of the frame width. */
const MAX_WRAP_PCT = 1 - 2 * REFLOW_SAFE_MARGIN;
/** A rect within this fraction of both frame edges on an axis spans that axis. */
const BLEED_EDGE = 0.02;

const round = (n: number): number => Math.round(n * 100) / 100;

/** The uniform scale between two frames: the ratio of their short sides. */
export function reflowScale(from: ReflowFrame, to: ReflowFrame): number {
  return Math.min(to.width, to.height) / Math.min(from.width, from.height);
}

/** Whether the frames differ at all (a different aspect OR a different size). */
export function framesDiffer(from: ReflowFrame, to: ReflowFrame): boolean {
  return from.width !== to.width || from.height !== to.height;
}

type AxisPin = "near" | "centre" | "far";

const spansAxis = (start: number, size: number, len: number): boolean =>
  start <= BLEED_EDGE * len && start + size >= (1 - BLEED_EDGE) * len;

/** Which of the near edge, the far edge or the centre a span on an axis is closest to. */
function pinOf(start: number, size: number, len: number): AxisPin {
  const dNear = Math.max(start, 0);
  const dFar = Math.max(len - start - size, 0);
  const dCentre = Math.abs(start + size / 2 - len / 2);
  if (dCentre <= dNear && dCentre <= dFar) return "centre";
  return dNear <= dFar ? "near" : "far";
}

interface AxisPlacement {
  start: number;
  size: number;
}

/** One axis of the mapping. `size` is the span's already-fitted new size. */
function placeAxis(start: number, size: number, from: number, to: number, newSize: number, s: number, spans: boolean): AxisPlacement {
  if (spans) return { start: (start / from) * to, size: newSize };
  const pin = pinOf(start, size, from);
  let at: number;
  if (pin === "near") at = start * s;
  else if (pin === "far") at = to - (from - start - size) * s - newSize;
  else at = to / 2 + (start + size / 2 - from / 2) * s - newSize / 2;
  // Inside the safe margin, unless the layer already ran past it on that side.
  const lo = start / from >= REFLOW_SAFE_MARGIN ? REFLOW_SAFE_MARGIN * to : 0;
  const hi = (from - start - size) / from >= REFLOW_SAFE_MARGIN ? (1 - REFLOW_SAFE_MARGIN) * to : to;
  at = newSize > hi - lo ? (to - newSize) / 2 : Math.min(Math.max(at, lo), hi - newSize);
  return { start: at, size: newSize };
}

export interface MappedRect {
  rect: OverlayRect;
  /** Uniform factor the layer's own content (type, strokes, 3D offsets) scales by: the frame scale times any safe-area shrink. */
  scale: number;
  /** The layer was made smaller than the frame scale to fit the safe area. */
  shrunk: boolean;
  /** The rect spans the whole width / height of its frame, so it spans the new one. */
  spansX: boolean;
  spansY: boolean;
}

/** One rect from the `from` frame into the `to` frame (see the module header). */
export function mapRect(rect: OverlayRect, from: ReflowFrame, to: ReflowFrame): MappedRect {
  const s = reflowScale(from, to);
  const spansX = spansAxis(rect.x, rect.width, from.width);
  const spansY = spansAxis(rect.y, rect.height, from.height);
  let w = spansX ? (rect.width / from.width) * to.width : rect.width * s;
  let h = spansY ? (rect.height / from.height) * to.height : rect.height * s;
  let k = 1;
  if (!spansX && w > to.width * (1 - 2 * REFLOW_SAFE_MARGIN)) k = Math.min(k, (to.width * (1 - 2 * REFLOW_SAFE_MARGIN)) / w);
  if (!spansY && h > to.height * (1 - 2 * REFLOW_SAFE_MARGIN)) k = Math.min(k, (to.height * (1 - 2 * REFLOW_SAFE_MARGIN)) / h);
  if (!spansX) w *= k;
  if (!spansY) h *= k;
  const x = placeAxis(rect.x, rect.width, from.width, to.width, w, s, spansX);
  const y = placeAxis(rect.y, rect.height, from.height, to.height, h, s, spansY);
  return {
    rect: { x: round(x.start), y: round(y.start), width: round(x.size), height: round(y.size) },
    scale: s * k,
    shrunk: k < 1,
    spansX,
    spansY,
  };
}

type Layer = Record<string, unknown> & { kind: string; rect: OverlayRect };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Scale `px` sizes in a font shorthand ("700 64px Inter, sans-serif"): the first size only. */
function scaleFontShorthand(font: string, k: number): string {
  return font.replace(/(\d+(?:\.\d+)?)px/, (_m, n: string) => `${round(parseFloat(n) * k)}px`);
}

/** The text-only fields of a layer, scaled by `k` (a `null` / absent field is left alone). */
function scaleTextLook(layer: Record<string, unknown>, k: number): void {
  if (num(layer.fontSize)) layer.fontSize = round(layer.fontSize * k);
  if (typeof layer.font === "string") layer.font = scaleFontShorthand(layer.font, k);
  if (isObj(layer.stroke) && num(layer.stroke.width)) layer.stroke = { ...layer.stroke, width: round(layer.stroke.width * k) };
  if (isObj(layer.shadow)) {
    const sh: Record<string, unknown> = { ...layer.shadow };
    for (const f of ["blur", "dx", "dy"]) if (num(sh[f])) sh[f] = round((sh[f] as number) * k);
    layer.shadow = sh;
  }
  if (isObj(layer.background)) {
    const bg: Record<string, unknown> = { ...layer.background };
    for (const f of ["padding", "radius"]) if (num(bg[f])) bg[f] = round((bg[f] as number) * k);
    layer.background = bg;
  }
}

/** A point inside the box `from`, carried to the same relative place inside the box `to`. */
export function mapPointBetweenRects(point: { x: number; y: number }, from: OverlayRect, to: OverlayRect): { x: number; y: number } {
  const fx = from.width > 0 ? to.width / from.width : 1;
  const fy = from.height > 0 ? to.height / from.height : 1;
  return { x: round(to.x + (point.x - from.x) * fx), y: round(to.y + (point.y - from.y) * fy) };
}

export interface ReflowedLayer {
  layer: Record<string, unknown>;
  /** What did not fit or may not read the way the template did, in libi's words. */
  warnings: string[];
}

/**
 * One layer (a persisted overlay's fields; `kind` and `rect` required) laid out for `to`.
 * Returns a copy; `label` names the layer in its warnings.
 */
export function reflowLayer(input: Layer, from: ReflowFrame, to: ReflowFrame, label: string): ReflowedLayer {
  const warnings: string[] = [];
  const layer: Record<string, unknown> = { ...input };
  const mapped = mapRect(input.rect, from, to);
  layer.rect = mapped.rect;
  const k = mapped.scale;

  if (input.kind === "text") {
    scaleTextLook(layer, k);
    if (isObj(input.position) && num(input.position.x) && num(input.position.y)) {
      // Keep the point where it sat inside the box it belongs to.
      layer.position = mapPointBetweenRects(input.position as { x: number; y: number }, input.rect, mapped.rect);
    }
    if (num(input.maxWidthPct) && !mapped.spansX) {
      const wanted = (input.maxWidthPct * from.width * k) / to.width;
      if (wanted > MAX_WRAP_PCT) {
        layer.maxWidthPct = MAX_WRAP_PCT;
        warnings.push(`${label}: text wraps at the safe width of this frame, so it may run to more lines than the template's; check its height`);
      } else layer.maxWidthPct = round(wanted * 1000) / 1000;
    }
  }

  if (isObj(input.keyframes)) {
    let kf = followRectKeyframes(input.keyframes as OverlayKeyframes, input.rect, mapped.rect);
    const t3 = kf?.transform3d;
    if (kf && t3) kf = { ...kf, transform3d: { keyframes: t3.keyframes.map((key) => ({ ...key, value: scaleTransformOffset(key.value, k) })) } };
    layer.keyframes = kf;
  }
  if (isObj(input.transform3d)) layer.transform3d = scaleTransformOffset(input.transform3d as unknown as Transform3D, k);

  if (mapped.shrunk) warnings.push(`${label}: scaled down to fit inside this frame's safe area`);
  if (input.kind === "code" || input.kind === "three") {
    warnings.push(`${label}: its code draws for the template's ${from.width}×${from.height} frame; render it once and check it fits`);
  }
  return { layer, warnings };
}
