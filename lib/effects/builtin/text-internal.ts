// lib/effects/builtin/text-internal.ts
// Text-internal reveal effects. Consumed by the SP5 glyph renderer (via the
// overlay's `reveal` field), NOT the transform compositor — so `animate` returns
// identity and `textInternal: true` makes composeEffects skip them. They exist in
// the registry for DISCOVERY (list_effects / picker / skill) and so
// apply_layer_effect accepts them; the apply layer mirrors them into `reveal`.
import type { EffectDef } from "../types";

function textInternal(id: string, name: string): EffectDef {
  return {
    meta: {
      id, name, family: "animation",
      phases: ["in"],
      supports: ["text"],
      params: [],
      textInternal: true,
      defaultDurationMs: 800,
    },
    animate: () => ({}),
  };
}

export const typewriterEffect = textInternal("typewriter", "Typewriter");
export const fadeWordsEffect = textInternal("fade-words", "Fade words");
export const slideUpLinesEffect = textInternal("slide-up-lines", "Slide-up lines");
// Time-synced caption reveals (pace off the whole cue window off real word
// timings, not a one-shot duration). Registered so an applied karaoke /
// word-by-word caption resolves in the effects inspector and round-trips
// through the reveal↔effects.in bridge.
export const karaokeEffect = textInternal("karaoke", "Karaoke");
export const wordCurrentEffect = textInternal("word-current", "Word by word");
