import type { ToolResult } from "./types";
import { listEffects, findEffect } from "@/lib/effects/registry";
import { refreshCustomEffects } from "@/lib/effects/packages";
import { applyEffectToLayer, clearEffectOnLayer } from "@/lib/effects/apply";
import { revealForTextInternal } from "@/lib/effects/text-internal-reveal";
import { TEXT_INTERNAL_EFFECT_IDS } from "@/lib/effects/builtin";
import { loadManifest } from "@/lib/composition/persistence";
import { notify } from "@/mcp/notify";
import type { EffectPhase, LayerKind } from "@/lib/effects/types";

/**
 * Load custom effect packages from disk into the registry instance THIS bundle
 * reads. The Category-B boot registers customs, but Next bundles instrumentation,
 * route handlers, and the MCP child as separate module instances — so a boot-time
 * registration is not guaranteed visible where `findEffect`/`listEffects` actually
 * run. Re-ensuring at tool-call time (a cheap read of a small dir) makes custom
 * resolution correct across every server-side entry point and always reflects the
 * current on-disk package set. Never throws — a disk error falls back to built-ins.
 */
function ensureCustomEffectsLoaded(): void {
  try {
    refreshCustomEffects();
  } catch {
    // disk error → built-ins only; never break the tool
  }
}

const ALL_IDS = () => listEffects().map((e) => e.meta.id);

function summary(kind?: LayerKind, phase?: EffectPhase) {
  return listEffects({ kind, phase }).map((e) => ({
    id: e.meta.id,
    name: e.meta.name,
    phases: e.meta.phases,
    supports: e.meta.supports,
    params: e.meta.params,
    defaultDurationMs: e.meta.defaultDurationMs ?? 400,
    textInternal: e.meta.textInternal ?? false,
    audioEnvelope: e.meta.audioEnvelope ?? false,
  }));
}

/** List built-in animation effects, optionally filtered by layer kind / phase. */
export async function listEffectsTool(params: {
  kind?: LayerKind;
  phase?: EffectPhase;
}): Promise<ToolResult> {
  ensureCustomEffectsLoaded();
  return { success: true, data: { effects: summary(params.kind, params.phase) } };
}

/** Apply an animation effect to a layer's in/out/loop slot. */
export async function applyLayerEffect(params: {
  pieceId: string;
  layerId: string;
  phase: EffectPhase;
  effectId: string;
  durationMs?: number;
  params?: Record<string, number | string>;
}): Promise<ToolResult> {
  ensureCustomEffectsLoaded();
  const def = findEffect(params.effectId);
  if (!def) {
    return {
      success: false,
      error: "unknown_effect",
      data: {
        hint: `Unknown effectId "${params.effectId}". Call libi.list_effects.`,
        validIds: ALL_IDS(),
      },
    };
  }
  if (!def.meta.phases.includes(params.phase)) {
    return {
      success: false,
      error: "phase_unsupported",
      data: {
        hint: `Effect "${params.effectId}" has no "${params.phase}" slot. Valid: ${def.meta.phases.join(", ")}.`,
      },
    };
  }

  // Text-internal effects (typewriter / fade-words / …) also mirror onto the
  // overlay's legacy `reveal` field. Compute that directive up-front and apply it
  // in the SAME manifest save as the effect ref (applyEffectToLayer ignores it for
  // non-text layers). Doing both in one save avoids the read-after-write race that
  // made a removed effect re-appear. `durationMs` is carried so the renderer paces
  // the reveal off wall-clock ms (e.g. 800ms), not the overlay's full duration.
  const textReveal =
    def.meta.textInternal && params.phase === "in"
      ? (() => {
          const r = revealForTextInternal(params.effectId);
          if (!r) return undefined;
          const durationMs = params.durationMs ?? def.meta.defaultDurationMs;
          return durationMs ? { ...r, durationMs } : r;
        })()
      : undefined;

  const ref = { effectId: params.effectId, durationMs: params.durationMs, params: params.params };
  const result = await applyEffectToLayer({
    pieceId: params.pieceId,
    layerId: params.layerId,
    phase: params.phase,
    ref,
    textReveal,
  });
  if (result.layerKind === null) {
    return {
      success: false,
      error: "layer_not_found",
      data: { hint: `No overlay/scene/audio clip with id "${params.layerId}".` },
    };
  }

  const resolvedKind = (
    result.layerKind.startsWith("overlay-")
      ? result.layerKind.slice("overlay-".length)
      : result.layerKind
  ) as LayerKind;
  if (!def.meta.supports.includes(resolvedKind)) {
    await clearEffectOnLayer({ pieceId: params.pieceId, layerId: params.layerId, phase: params.phase });
    return {
      success: false,
      error: "kind_unsupported",
      data: {
        hint: `Effect "${params.effectId}" does not support ${resolvedKind} layers. Supports: ${def.meta.supports.join(", ")}.`,
      },
    };
  }

  notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
  return { success: true, data: { layerKind: result.layerKind } };
}

/** Guided edit: flash an effect for the user — a catalog effect or one
 *  already applied to a layer's slot. Fire-and-forget notify. */
export async function highlightEffect(params: {
  pieceId: string;
  target: { kind: "catalog"; effectId: string; phase?: EffectPhase } | { kind: "applied"; layerId: string; phase: EffectPhase };
  note?: string;
}): Promise<ToolResult> {
  ensureCustomEffectsLoaded();
  if (params.target.kind === "catalog" && !findEffect(params.target.effectId)) {
    return {
      success: false,
      error: "unknown_effect",
      data: {
        hint: `Unknown effectId "${params.target.effectId}". Call libi.list_effects.`,
        validIds: ALL_IDS(),
      },
    };
  }
  notify.highlightEffect({ pieceId: params.pieceId, target: params.target, note: params.note });
  return { success: true, data: { highlighted: true } };
}

/** Remove the effect on a layer's in/out/loop slot. */
export async function clearLayerEffect(params: {
  pieceId: string;
  layerId: string;
  phase: EffectPhase;
}): Promise<ToolResult> {
  // Couple reveal removal to clearing the `in` slot ONLY when that slot actually
  // holds the text-internal reveal MIRROR (karaoke/typewriter/…) — never when it
  // holds a REAL box animation (fade/slide/…). Clearing a real in-animation must
  // leave the caption's reveal intact (the reveal has its own dedicated remove).
  // Previously this always cleared reveal on any `in` clear, so removing a fade-in
  // also wiped the reveal. The reveal↔mirror resurrection the old coupling guarded
  // against is now handled by `stripRevealMirror` at save time.
  let clearReveal = false;
  if (params.phase === "in") {
    const manifest = await loadManifest(params.pieceId);
    const ov = manifest.overlays?.find((o) => o.id === params.layerId) as
      | { kind?: string; effects?: { in?: { effectId?: string } } }
      | undefined;
    const inId = ov?.effects?.in?.effectId;
    clearReveal = ov?.kind === "text" && !!inId && TEXT_INTERNAL_EFFECT_IDS.has(inId);
  }
  const result = await clearEffectOnLayer({
    ...params,
    textReveal: clearReveal ? null : undefined,
  });
  if (result.layerKind === null) {
    return {
      success: false,
      error: "layer_not_found",
      data: { hint: `No layer "${params.layerId}".` },
    };
  }
  notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
  return { success: true, data: { layerKind: result.layerKind } };
}
