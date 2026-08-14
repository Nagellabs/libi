// lib/effects/text-internal-reveal.ts
/** Map a text-internal effect id back to the legacy `reveal` field the SP5 glyph
 *  renderer consumes. INVERSE of lib/overlays/hydrate.ts#REVEAL_TO_EFFECT — note
 *  the `slide-up-lines` EFFECT id maps to the `slide-up` reveal MODE (they differ).
 *  reveal shape is `{ mode: string; fraction?: number }`. */
export function revealForTextInternal(effectId: string): { mode: string } | null {
  switch (effectId) {
    case "typewriter": return { mode: "typewriter" };
    case "fade-words": return { mode: "fade-words" };
    case "slide-up-lines": return { mode: "slide-up" }; // effect id ≠ reveal mode
    case "karaoke": return { mode: "karaoke" };
    case "word-current": return { mode: "word-current" };
    default: return null;
  }
}
