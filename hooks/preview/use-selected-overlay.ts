"use client";

import { useSyncExternalStore } from "react";
import type { SelectionStore } from "@/lib/preview/selection-store";

/**
 * Subscribe a component to the selected overlay id. ONLY components that must
 * react to selection (the transform controls, the layer list, the inspector,
 * the timeline bars) should call this — keeping selection re-renders scoped to
 * them instead of the whole editor. `store.get` doubles as the SSR snapshot.
 */
export function useSelectedOverlay(store: SelectionStore): string | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * Subscribe to the WHOLE ordered selection (multi-select). `getAll` returns a
 * referentially-stable snapshot (replaced only on a real content change), so it
 * is safe as the useSyncExternalStore snapshot. Used by the batch-style bar and
 * the timeline multi-highlight.
 */
export function useSelectedOverlayIds(store: SelectionStore): string[] {
  return useSyncExternalStore(store.subscribe, store.getAll, store.getAll);
}
