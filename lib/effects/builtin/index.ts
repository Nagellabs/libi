// lib/effects/builtin/index.ts
import type { EffectDef } from "../types";
import { fadeEffect } from "./fade";
import { slideEffect } from "./slide";
import { popEffect } from "./pop";
import { zoomEffect } from "./zoom";
import { depthTravelEffect } from "./depth-travel";
import { pulseEffect } from "./pulse";
import { shakeEffect } from "./shake";
import { bounceEffect } from "./bounce";
import { flashEffect } from "./flash";
import { blurEffect } from "./blur";
import { elasticEffect } from "./elastic";
import { spinEffect } from "./spin";
import { waveEffect } from "./wave";
import { floatEffect } from "./float";
import { swayEffect } from "./sway";
import { breatheEffect } from "./breathe";
import { blinkEffect } from "./blink";
import { spin360Effect } from "./spin-360";
import { glitchEffect } from "./glitch";
import { wipeEffect } from "./wipe";
import { audioFadeIn, audioFadeOut } from "./audio-fade";
import {
  typewriterEffect,
  fadeWordsEffect,
  slideUpLinesEffect,
  karaokeEffect,
  wordCurrentEffect,
} from "./text-internal";

/** The ONE definition site for built-in effects. Each effect task appends its
 *  EffectDef here. The registry, picker, list_effects tool, and skill drift
 *  test all derive from this array — never a second hand-maintained list. */
export const BUILTIN_EFFECTS: EffectDef[] = [
  fadeEffect,
  slideEffect,
  popEffect,
  zoomEffect,
  depthTravelEffect,
  pulseEffect,
  shakeEffect,
  bounceEffect,
  flashEffect,
  blurEffect,
  elasticEffect,
  spinEffect,
  waveEffect,
  floatEffect,
  swayEffect,
  breatheEffect,
  blinkEffect,
  spin360Effect,
  glitchEffect,
  wipeEffect,
  audioFadeIn,
  audioFadeOut,
  typewriterEffect,
  fadeWordsEffect,
  slideUpLinesEffect,
  karaokeEffect,
  wordCurrentEffect,
];

/** The ids of the text-internal REVEAL effects — the ones that are pure mirrors
 *  of `overlay.reveal` (identity `animate`, skipped by composeEffects, not
 *  applicable via the Animations grid). Used to (a) strip the persisted mirror
 *  on save so `reveal` is the single source of truth — a cleared reveal can't
 *  resurrect from a stale `effects.in` — and (b) hide the meaningless Duration
 *  field + route the inspector's clear to `reveal`. Derived from the registry so
 *  it can't drift from the definitions above. */
export const TEXT_INTERNAL_EFFECT_IDS: ReadonlySet<string> = new Set(
  BUILTIN_EFFECTS.filter((e) => e.meta.textInternal).map((e) => e.meta.id),
);
