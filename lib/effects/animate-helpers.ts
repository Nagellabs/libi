// lib/effects/animate-helpers.ts
//
// The pure-math helper set injected into a custom effect's `animate.js` body.
// ONLY pure math — interpolation, spring physics, easing, clamp/lerp. NO
// canvas/ctx/drawing helpers (an animate body returns a TransformDelta, it
// never touches a canvas).
import {
  interpolate,
  spring,
  stagger,
  linear,
  easeIn,
  easeOut,
  easeInOut,
  easeInCubic,
  easeOutCubic,
  easeInOutCubic,
  easeInBack,
  easeOutBack,
  easeOutElastic,
} from "@/lib/engine/animation";

/** Clamp `v` into the inclusive [min, max] range. */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Linear interpolation between `a` and `b` by `t` (0→1). */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Pure math helpers injected into a custom effect animate body. */
export const EFFECT_ANIMATE_HELPERS: Record<string, unknown> = {
  interpolate,
  spring,
  stagger,
  clamp,
  lerp,
  linear,
  easeIn,
  easeOut,
  easeInOut,
  easeInCubic,
  easeOutCubic,
  easeInOutCubic,
  easeInBack,
  easeOutBack,
  easeOutElastic,
};
