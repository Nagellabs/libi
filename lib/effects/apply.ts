// lib/effects/apply.ts
import type { EffectPhase, EffectRef } from "./types";
import {
  loadManifest,
  saveManifest,
  updateSceneInManifest,
} from "@/lib/composition/persistence";

export interface ApplyEffectInput {
  pieceId: string;
  layerId: string;
  phase: EffectPhase;
  /** The effect to set on this slot, or null to clear it. */
  ref: EffectRef | null;
  /** TEXT overlays only: also set (or clear, with `null`) the legacy `reveal`
   *  field in the SAME manifest save. Text-internal effects (typewriter / fade-
   *  words / …) mirror onto `reveal`; doing it here — rather than a second
   *  load-save cycle in the tool — avoids the read-after-write race where the
   *  second save re-loaded a stale manifest and clobbered this effect-ref change
   *  (the "removed effect re-appears" bug). `undefined` ⇒ leave `reveal`
   *  untouched. Ignored for non-text layers. */
  textReveal?: { mode: string; durationMs?: number; fraction?: number } | null;
}

/** Which kind of layer the id resolved to (overlay kind tagged), or null. */
export type ResolvedLayerKind = `overlay-${string}` | "scene" | "audio" | null;

export interface ApplyEffectResult {
  layerKind: ResolvedLayerKind;
}

type EffectsBlock = { in?: EffectRef; out?: EffectRef; loop?: EffectRef };

function setPhase(
  existing: EffectsBlock | undefined,
  phase: EffectPhase,
  ref: EffectRef | null,
): EffectsBlock | undefined {
  const next: EffectsBlock = { ...(existing ?? {}) };
  if (ref === null) delete next[phase];
  else next[phase] = ref;
  return next.in || next.out || next.loop ? next : undefined;
}

export async function applyEffectToLayer(
  input: ApplyEffectInput,
): Promise<ApplyEffectResult> {
  const { pieceId, layerId, phase, ref } = input;
  const manifest = await loadManifest(pieceId);

  const overlays = manifest.overlays ?? [];
  const ov = overlays.find((o) => o.id === layerId) as
    | ((typeof overlays)[number] & { effects?: EffectsBlock })
    | undefined;
  if (ov) {
    const block = setPhase(ov.effects, phase, ref);
    if (block === undefined) delete (ov as { effects?: unknown }).effects;
    else ov.effects = block;
    // Text-internal reveal coupling, applied in THIS same save (see ApplyEffectInput.textReveal).
    if (ov.kind === "text" && input.textReveal !== undefined) {
      const tov = ov as { reveal?: unknown; version?: number };
      if (input.textReveal === null) delete tov.reveal;
      else tov.reveal = input.textReveal;
      // Bump the per-overlay version so the client edit store reconciles (mirrors
      // updateOverlayInManifest, which used to own this write).
      tov.version = (tov.version ?? 0) + 1;
    }
    manifest.overlays = overlays;
    await saveManifest(pieceId, manifest);
    return { layerKind: `overlay-${ov.kind}` as ResolvedLayerKind };
  }

  const scenes = manifest.scenes ?? [];
  const sc = scenes.find((s) => s.id === layerId) as
    | ((typeof scenes)[number] & { effects?: EffectsBlock })
    | undefined;
  if (sc) {
    const block = setPhase(sc.effects, phase, ref);
    if (block === undefined) delete (sc as { effects?: unknown }).effects;
    else sc.effects = block;
    await updateSceneInManifest(pieceId, sc);
    return { layerKind: "scene" };
  }

  const clips = manifest.audioClips ?? [];
  const clip = clips.find((c) => c.id === layerId) as
    | ((typeof clips)[number] & { effects?: EffectsBlock })
    | undefined;
  if (clip) {
    const block = setPhase(clip.effects, phase, ref);
    if (block === undefined) delete (clip as { effects?: unknown }).effects;
    else clip.effects = block;
    manifest.audioClips = clips;
    await saveManifest(pieceId, manifest);
    return { layerKind: "audio" };
  }

  return { layerKind: null };
}

export async function clearEffectOnLayer(
  input: Omit<ApplyEffectInput, "ref">,
): Promise<ApplyEffectResult> {
  return applyEffectToLayer({ ...input, ref: null });
}
