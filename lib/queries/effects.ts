"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { pieceKeys } from "@/lib/queries/pieces";
import { trackEvent } from "@/lib/analytics/client";
import type { EffectPhase, EffectRef } from "@/lib/effects/types";

export interface ApplyLayerEffectArgs {
  layerId: string;
  phase: EffectPhase;
  effectId: string;
  durationMs?: number;
  params?: Record<string, number | string>;
}

/** The effects block stored on a layer (mirrors `lib/effects/apply.ts`). */
type EffectsBlock = { in?: EffectRef; out?: EffectRef; loop?: EffectRef };

/** A layer the effects route can resolve: overlay / scene / audio clip. All
 *  carry an optional `effects` block keyed by phase. */
interface EffectsLayer {
  id: string;
  effects?: EffectsBlock;
}

/** The cached `usePieceComposition` response shape. Effects live on
 *  `manifest.overlays[].effects`, `manifest.scenes[].effects`, and
 *  `manifest.audioClips[].effects` — the three lists the route writes. */
interface CachedComposition {
  manifest: {
    overlays?: EffectsLayer[];
    scenes?: EffectsLayer[];
    audioClips?: EffectsLayer[];
  } & Record<string, unknown>;
  scenes: unknown;
  audioClips: unknown;
}

/**
 * Server merge mirror (`setPhase` in `lib/effects/apply.ts`): set `ref` on the
 * given phase (or delete it when `ref === null`), then drop the whole `effects`
 * block when no phase remains. Returns the next block, or `undefined` to clear.
 */
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

/**
 * Pure optimistic cache helper: finds the layer with id `layerId` across
 * overlays → scenes → audioClips (the same resolution order as the server's
 * `applyEffectToLayer`) and rewrites its `effects` block via `setPhase`.
 *
 * Null-safe: returns `prev` unchanged when the cache is missing or no layer
 * matches, so a missing/stale cache never throws.
 */
function applyEffectToCache(
  prev: CachedComposition | undefined,
  layerId: string,
  phase: EffectPhase,
  ref: EffectRef | null,
): CachedComposition | undefined {
  if (!prev) return prev;

  const lists = ["overlays", "scenes", "audioClips"] as const;
  for (const listKey of lists) {
    const list = prev.manifest[listKey];
    if (!list) continue;
    const idx = list.findIndex((l) => l.id === layerId);
    if (idx < 0) continue;

    const layer = list[idx];
    const block = setPhase(layer.effects, phase, ref);
    const nextLayer: EffectsLayer = { ...layer };
    if (block === undefined) delete nextLayer.effects;
    else nextLayer.effects = block;

    const nextList = list.slice();
    nextList[idx] = nextLayer;
    return {
      ...prev,
      manifest: { ...prev.manifest, [listKey]: nextList },
    };
  }

  return prev;
}

/** Apply an effect to a layer (overlay/scene/audio) via the REST seam.
 *  Optimistically patches the cached composition so the canvas repaints this
 *  React cycle (no network in the feedback loop), then persists in the
 *  background; rolls back the cache on error. */
export function useApplyLayerEffect(pieceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: ApplyLayerEffectArgs) => {
      if (!pieceId) throw new Error("no pieceId");
      const res = await fetch(
        `/api/pieces/${pieceId}/layers/${encodeURIComponent(args.layerId)}/effects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phase: args.phase,
            effectId: args.effectId,
            durationMs: args.durationMs,
            params: args.params,
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `apply failed (${res.status})`);
      }
      return (await res.json()) as { success: true; layerKind: string };
    },
    onMutate: async (args) => {
      if (!pieceId) return { prev: undefined };
      const key = pieceKeys.composition(pieceId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<CachedComposition>(key);
      // Build the EffectRef exactly as the MCP tool / route does.
      const ref: EffectRef = {
        effectId: args.effectId,
        durationMs: args.durationMs,
        params: args.params,
      };
      qc.setQueryData<CachedComposition>(key, (cur) =>
        applyEffectToCache(cur, args.layerId, args.phase, ref),
      );
      return { prev };
    },
    onError: (_err, _args, ctx) => {
      if (pieceId && ctx?.prev !== undefined) {
        qc.setQueryData(pieceKeys.composition(pieceId), ctx.prev);
      }
    },
    onSuccess: (_data, args) => {
      // family is always "animation" in this initiative (bounded-cardinality).
      trackEvent("effect_applied", { family: "animation", phase: args.phase });
      // No invalidate: the optimistic cache already matches the server merge, so
      // the canvas is correct. The SSE `refresh_query composition` path (emitted
      // by the route) reconciles any drift without a network round-trip in the
      // edit feedback loop — and never revert-flashes.
    },
  });
}

export function useClearLayerEffect(pieceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { layerId: string; phase: EffectPhase }) => {
      if (!pieceId) throw new Error("no pieceId");
      const res = await fetch(
        `/api/pieces/${pieceId}/layers/${encodeURIComponent(args.layerId)}/effects?phase=${args.phase}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `clear failed (${res.status})`);
      }
      return (await res.json()) as { success: true };
    },
    onMutate: async (args) => {
      if (!pieceId) return { prev: undefined };
      const key = pieceKeys.composition(pieceId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<CachedComposition>(key);
      qc.setQueryData<CachedComposition>(key, (cur) =>
        // ref === null → remove the phase (mirrors clearEffectOnLayer).
        applyEffectToCache(cur, args.layerId, args.phase, null),
      );
      return { prev };
    },
    onError: (_err, _args, ctx) => {
      if (pieceId && ctx?.prev !== undefined) {
        qc.setQueryData(pieceKeys.composition(pieceId), ctx.prev);
      }
    },
    // No invalidate on success — the optimistic cache already matches the
    // server, and the route's SSE refresh reconciles without a flash.
  });
}

/**
 * Remove a text overlay's word REVEAL (karaoke/typewriter/…) — PATCHes
 * `reveal: null`. This is the correct "remove the reveal" action: `reveal` is
 * the source of truth, and the reveal PATCH also strips the persisted
 * `effects.in` mirror (saveManifest) so it can't resurrect on the next load.
 * Optimistically clears both `reveal` and the mirrored `effects.in` on the
 * cached overlay so the canvas + inspector update this cycle.
 */
export function useClearReveal(pieceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { layerId: string }) => {
      if (!pieceId) throw new Error("no pieceId");
      const res = await fetch(`/api/pieces/${pieceId}/overlays/${args.layerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reveal: null }),
      });
      if (!res.ok) throw new Error(`clear reveal failed (${res.status})`);
      return (await res.json()) as { success: true };
    },
    onMutate: async (args) => {
      if (!pieceId) return { prev: undefined };
      const key = pieceKeys.composition(pieceId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<CachedComposition>(key);
      qc.setQueryData<CachedComposition>(key, (cur) => {
        if (!cur) return cur;
        const overlays = cur.manifest.overlays;
        if (!overlays) return cur;
        const idx = overlays.findIndex((o) => o.id === args.layerId);
        if (idx < 0) return cur;
        const layer = overlays[idx] as unknown as Record<string, unknown>;
        const next = { ...layer };
        delete next.reveal;
        // Drop the mirrored in-effect too so the inspector clears immediately.
        const effects = { ...(next.effects as EffectsBlock | undefined) };
        delete effects.in;
        if (effects.out || effects.loop) next.effects = effects;
        else delete next.effects;
        const nextList = overlays.slice();
        nextList[idx] = next as unknown as (typeof overlays)[number];
        return { ...cur, manifest: { ...cur.manifest, overlays: nextList } };
      });
      return { prev };
    },
    onError: (_err, _args, ctx) => {
      if (pieceId && ctx?.prev !== undefined) {
        qc.setQueryData(pieceKeys.composition(pieceId), ctx.prev);
      }
    },
  });
}
