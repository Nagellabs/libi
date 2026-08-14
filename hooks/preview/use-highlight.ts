"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  createHighlightStore,
  targetGroupForHighlight,
  type HighlightStore,
  type HighlightValue,
} from "@/lib/preview/highlight-store";
import {
  groupsForKind,
  defaultGroupForKind,
  type InspectorGroup,
  type InspectorOverlayKind,
} from "@/lib/overlays/inspector-fields";
import type { Composition } from "@/lib/engine/types";
import type { SelectionStore } from "@/lib/preview/selection-store";
import {
  highlightEmitter,
  setComplexityModeEmitter,
} from "@/hooks/sessions/use-agent-chat";

export interface UseHighlightArgs {
  pieceId: string;
  selectionStore: SelectionStore;
  /** Live composition — used to resolve a targeted overlay's kind by id. */
  composition: Composition | null;
  /** Per-overlay inspector tab setter (from editor-state context). */
  setOverlayInspectorMode: (
    pieceId: string,
    overlayId: string,
    mode: InspectorGroup,
  ) => void;
}

/**
 * Owns the per-surface `HighlightStore` and applies the agent's guided-edit
 * signals PER OVERLAY: on `highlight` (for THIS piece) it selects the overlay,
 * switches THAT overlay's inspector tab to the targeted field's tier, and
 * stores the highlight so the matching `<TierField>` flashes. On
 * `set_complexity_mode` it switches THAT overlay's tab to the requested mode
 * (clamped to the kind's available tiers). The overlay's kind is resolved from
 * the live composition by id.
 */
export function useHighlight({
  pieceId,
  selectionStore,
  composition,
  setOverlayInspectorMode,
}: UseHighlightArgs): HighlightStore {
  // Created once via a lazy useState initializer (the create-once idiom that
  // doesn't read a ref during render); the setter is intentionally unused.
  const [store] = useState<HighlightStore>(createHighlightStore);

  // Read the latest composition imperatively so the subscription effect doesn't
  // re-bind on every composition refetch. Written in an effect (never during
  // render); the emitter callbacks that read it only fire post-commit.
  const compositionRef = useRef(composition);
  useEffect(() => {
    compositionRef.current = composition;
  });

  const kindOf = (overlayId: string): InspectorOverlayKind => {
    const kind = compositionRef.current?.overlays?.find(
      (o) => o.id === overlayId,
    )?.kind;
    return (kind ?? "text") as InspectorOverlayKind;
  };

  useEffect(() => {
    const unsubHighlight = highlightEmitter.on((e) => {
      if (e.pieceId !== pieceId) return;
      selectionStore.set(e.overlayId);
      const kind = kindOf(e.overlayId);
      setOverlayInspectorMode(
        pieceId,
        e.overlayId,
        targetGroupForHighlight(e.property, kind),
      );
      store.set({ overlayId: e.overlayId, property: e.property, note: e.note });
    });
    const unsubMode = setComplexityModeEmitter.on((e) => {
      // A set-mode event may omit pieceId (legacy); only the overlay id is
      // required. Skip events scoped to a different piece.
      if (e.pieceId !== undefined && e.pieceId !== pieceId) return;
      if (!e.overlayId) return;
      const kind = kindOf(e.overlayId);
      const group = groupsForKind(kind).includes(e.mode)
        ? e.mode
        : defaultGroupForKind(kind);
      setOverlayInspectorMode(pieceId, e.overlayId, group);
    });
    return () => {
      unsubHighlight();
      unsubMode();
    };
  }, [pieceId, selectionStore, setOverlayInspectorMode, store]);

  return store;
}

/** Subscribe a component to the active highlight value (for `<TierField>` flash). */
export function useHighlightValue(store: HighlightStore): HighlightValue | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
