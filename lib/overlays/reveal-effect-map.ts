// lib/overlays/reveal-effect-map.ts
/**
 * Mapping from a text `CaptionRevealMode` → the `effects.in` effectId that
 * mirrors it. Pure and CLIENT-SAFE (no server-only imports) so both the client
 * inspector and the server-side hydrate/save reconciliation can share ONE map.
 * (Kept out of `hydrate.ts`, which transitively imports `fs` via the logger and
 * therefore can't be pulled into a client component.)
 */
export const REVEAL_TO_EFFECT: Record<string, string> = {
  typewriter: "typewriter",
  "fade-words": "fade-words",
  "slide-up": "slide-up-lines",
  pop: "pop",
  karaoke: "karaoke",
  "word-current": "word-current",
};
