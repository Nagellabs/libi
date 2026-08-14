"use client";

import { useEffect, useState } from "react";
import {
  createEffectHighlightStore,
  type EffectHighlightStore,
} from "@/lib/preview/effect-highlight-store";
import type { SelectionStore } from "@/lib/preview/selection-store";
import { effectHighlightEmitter } from "@/hooks/sessions/use-agent-chat";

export interface UseEffectHighlightArgs {
  pieceId: string;
  selectionStore: SelectionStore;
  /** Open the effects panel when a highlight arrives (catalog highlight needs the grid visible). */
  setEffectsPanelOpen: (v: boolean) => void;
}

/**
 * Owns the per-surface EffectHighlightStore and applies `highlight_effect`:
 * a `catalog` target opens the panel + flashes the grid thumbnail; an `applied`
 * target selects the layer + flashes the inspector slot. Auto-clears via TTL.
 */
export function useEffectHighlight({
  pieceId,
  selectionStore,
  setEffectsPanelOpen,
}: UseEffectHighlightArgs): EffectHighlightStore {
  // Created once via a lazy useState initializer (the create-once idiom that
  // doesn't read a ref during render); the setter is intentionally unused.
  const [store] = useState<EffectHighlightStore>(createEffectHighlightStore);

  useEffect(() => {
    const unsub = effectHighlightEmitter.on((e) => {
      if (e.pieceId !== pieceId) return;
      if (e.target.kind === "catalog") {
        setEffectsPanelOpen(true);
        store.set({
          kind: "catalog",
          effectId: e.target.effectId,
          phase: e.target.phase,
          note: e.note,
        });
      } else {
        selectionStore.set(e.target.layerId);
        store.set({
          kind: "applied",
          layerId: e.target.layerId,
          phase: e.target.phase,
          note: e.note,
        });
      }
    });
    return unsub;
  }, [pieceId, selectionStore, setEffectsPanelOpen, store]);

  return store;
}
