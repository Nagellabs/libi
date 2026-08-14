import { serverLogger as logger } from "@/lib/logger";
import { overlayHasCode, setOverlayBody } from "./code-fields";
import { readOverlayCode } from "./code-files";
import { revealForTextInternal } from "@/lib/effects/text-internal-reveal";
import { TEXT_INTERNAL_EFFECT_IDS } from "@/lib/effects/builtin";
import { REVEAL_TO_EFFECT } from "@/lib/overlays/reveal-effect-map";
import type { CompositionManifest, PersistedOverlay } from "@/lib/composition/persistence";
import type { Overlay, TextOverlay } from "@/lib/engine/types";

/** Re-export the client-safe reveal→effect map (defined in reveal-effect-map.ts
 *  so it can be shared with client components without dragging in `fs`). */
export { REVEAL_TO_EFFECT };

/** Back-compat: expose a legacy text `reveal` as `effects.in` on load, without
 *  clobbering an explicit `effects.in`. Additive — the renderer still honors
 *  `reveal` directly (text-internal). */
export function revealToEffectIn<T extends Overlay>(overlay: T): T {
  if (overlay.kind !== "text") return overlay;
  const t = overlay as TextOverlay;
  if (!t.reveal || t.reveal.mode === "none") return overlay;
  if (t.effects?.in) return overlay; // explicit effects.in wins — don't clobber
  const effectId = REVEAL_TO_EFFECT[t.reveal.mode];
  if (!effectId) return overlay;
  return { ...overlay, effects: { ...t.effects, in: { effectId } } };
}

/** Back-compat / fix: a text-internal `effects.in` (typewriter / fade-words /
 *  slide-up-lines), e.g. applied via the effects panel, drives a glyph reveal —
 *  but the renderer animates that reveal off `overlay.reveal`, not `effects.in`.
 *  Bridge them: when a text overlay has a mapped `effects.in` and NO explicit
 *  `reveal`, synthesize `reveal` from the effect (INVERSE of `revealToEffectIn`,
 *  via `revealForTextInternal`). `effects.in.durationMs` maps to `reveal.fraction`
 *  (the fraction of the clip the reveal spans) so a short reveal plays quickly
 *  instead of smearing across the whole overlay window. An explicit `reveal`
 *  wins — never clobbered. Pure; no-op for non-text / unmapped / already-revealed. */
export function effectInToReveal<T extends Overlay>(overlay: T): T {
  if (overlay.kind !== "text") return overlay;
  const t = overlay as TextOverlay;
  if (t.reveal && t.reveal.mode !== "none") return overlay; // explicit reveal wins
  const inEffect = t.effects?.in;
  if (!inEffect?.effectId) return overlay;
  const mapped = revealForTextInternal(inEffect.effectId);
  if (!mapped) return overlay;
  // durationMs → fraction of the [startTime, startTime+duration] window, clamped
  // to [0.01, 1] so a tiny duration still produces an observable (not instant) reveal.
  const fraction =
    inEffect.durationMs && t.duration > 0
      ? Math.max(0.01, Math.min(1, inEffect.durationMs / (t.duration * 1000)))
      : undefined;
  const reveal = fraction != null ? { ...mapped, fraction } : mapped;
  return { ...overlay, reveal } as T;
}

/**
 * Populate each code-bearing overlay's body from its file, IN PLACE.
 * Strictly file-only: overlay code lives in files; composition.json never
 * carries it. A missing file → "" + warn (no inline fallback).
 * Also applies the reveal→effects.in back-compat shim on every overlay.
 */
export async function hydrateOverlayCode(pieceId: string, manifest: CompositionManifest): Promise<void> {
  const overlays = manifest.overlays;
  if (!overlays?.length) return;
  for (let i = 0; i < overlays.length; i++) {
    const o = overlays[i];
    // Apply the bidirectional reveal↔effects.in shims unconditionally (pure,
    // no-op for non-text): reveal→effects.in (so the effects panel shows it) AND
    // effects.in→reveal (so an effects-panel typewriter actually animates — the
    // renderer reads `reveal`). Each is a no-op when the other field is explicit.
    const hydrated: PersistedOverlay = effectInToReveal(
      revealToEffectIn(o as Overlay),
    ) as PersistedOverlay;
    if (!overlayHasCode(hydrated)) {
      overlays[i] = hydrated;
      continue;
    }
    const fromFile = await readOverlayCode(pieceId, hydrated);
    if (fromFile) {
      overlays[i] = setOverlayBody(hydrated, fromFile);
      continue;
    }
    logger.warn({ tag: "overlay", op: "hydrate_missing", pieceId, overlayId: hydrated.id }, "overlay code file missing");
    overlays[i] = setOverlayBody(hydrated, "");
  }
}

/**
 * Return a manifest clone with every text overlay's text-internal REVEAL mirror
 * (`effects.in` whose effectId is a text-internal reveal like karaoke/typewriter)
 * REMOVED, so `overlay.reveal` is the SINGLE persisted source of truth for word
 * reveals. `revealToEffectIn` re-derives the mirror on load for the effects
 * inspector; persisting it caused the "can't remove a reveal" bug — clearing
 * `reveal` left a stale `effects.in` that `effectInToReveal` resurrected on the
 * next load. Text-internal effects have identity `animate` and are skipped by
 * `composeEffects`, so dropping the mirror never changes rendering (the `reveal`
 * field alone drives it). A real animation `effects.in` (fade/slide/…) is left
 * untouched. Pure; clones only the overlays it changes.
 */
export function stripRevealMirror(manifest: CompositionManifest): CompositionManifest {
  if (!manifest.overlays?.length) return manifest;
  const overlays = manifest.overlays.map((o) => {
    const inEffect = (o as { effects?: { in?: { effectId?: string }; out?: unknown; loop?: unknown } }).effects?.in;
    if (o.kind !== "text" || !inEffect?.effectId || !TEXT_INTERNAL_EFFECT_IDS.has(inEffect.effectId)) {
      return o;
    }
    const effectsObj = (o as { effects?: Record<string, unknown> }).effects ?? {};
    const nextEffects: Record<string, unknown> = { ...effectsObj };
    delete nextEffects.in;
    const rest = { ...(o as Record<string, unknown>) };
    if (nextEffects.out || nextEffects.loop) rest.effects = nextEffects;
    else delete rest.effects;
    return rest as PersistedOverlay;
  });
  return { ...manifest, overlays };
}

/** Deep clone of the manifest with every code body emptied (for composition.json). */
export function stripOverlayCode(manifest: CompositionManifest): CompositionManifest {
  if (!manifest.overlays?.length) return manifest;
  const overlays: PersistedOverlay[] = manifest.overlays.map((o) =>
    overlayHasCode(o) ? setOverlayBody(o, "") : o,
  );
  return { ...manifest, overlays };
}
