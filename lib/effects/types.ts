// lib/effects/types.ts
/** The three animation slots an element can carry. */
export type EffectPhase = "in" | "out" | "loop";

/** Layer kinds an effect can support. Overlay kinds + "scene" (base video/image
 *  scene whole-frame) + "audio" (clip volume envelope). */
export type LayerKind =
  | "text" | "image" | "video" | "code" | "three" | "tracked" | "scene" | "audio";

/** One applied effect on one slot. */
export interface EffectRef {
  effectId: string;
  /** in/out window length in ms; omit → the effect's default. Ignored for loop. */
  durationMs?: number;
  params?: Record<string, number | string>;
}

/** The effects block stored on a layer. */
export interface LayerEffects {
  in?: EffectRef;
  out?: EffectRef;
  loop?: EffectRef;
}

/** A transform delta an effect contributes; the renderer composites it onto the
 *  element's existing center-anchored transform. All fields optional → identity. */
export interface TransformDelta {
  /** Element-local px translation. */
  dx?: number;
  dy?: number;
  /** Uniform scale multiplier (1 = no change). */
  scale?: number;
  /** Per-axis scale multipliers (multiplied on top of `scale`). */
  scaleX?: number;
  scaleY?: number;
  /** Additional clockwise rotation in degrees. */
  rotateDeg?: number;
  /** Opacity multiplier 0..1. */
  opacity?: number;
  /** Gaussian blur radius in px. */
  blurPx?: number;
  /** Edge-anchored reveal: clip the element to a fraction of its rect from an
   *  edge. fraction 1 = fully revealed (no clip), 0 = fully hidden. Used by wipe. */
  clipReveal?: { edge: "left" | "right" | "top" | "bottom"; fraction: number };
}

/** The identity (no-op) delta. */
export const IDENTITY_DELTA: TransformDelta = {};

/** A typed parameter an effect exposes (drives inspector + thumbnail later). */
export interface EffectParamDef {
  key: string;
  label: string;
  type: "number" | "enum" | "color";
  /** number params. */
  min?: number;
  max?: number;
  step?: number;
  /** number/color default. */
  default?: number | string;
  /** enum params. */
  options?: string[];
}

export interface EffectMeta {
  id: string;
  name: string;
  family: "animation";
  phases: EffectPhase[];
  supports: LayerKind[];
  params: EffectParamDef[];
  /** Default in/out window in ms (omit → 400). */
  defaultDurationMs?: number;
  /** Consumed by the text glyph renderer, not the whole-element transform. */
  textInternal?: boolean;
  /** Consumed by the audio engine (gain envelope), not the canvas. */
  audioEnvelope?: boolean;
}

export type ResolvedParams = Record<string, number | string>;

export interface EffectDef {
  meta: EffectMeta;
  /** Pure: progress 0→1 within this slot's window → a transform delta. */
  animate(progress: number, params: ResolvedParams): TransformDelta;
}
