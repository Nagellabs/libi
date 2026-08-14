"use client";

import { useSyncExternalStore } from "react";
import type {
  KeyframeSelectionStore,
  SelectedKeyframe,
} from "@/lib/preview/keyframe-selection-store";

/**
 * Subscribe a component to the selected keyframe `{ overlayId, t } | null`. ONLY
 * components that must react to keyframe selection (the timeline diamonds, and —
 * Phase 6 — the curve editor) should call this, keeping the re-render scoped to
 * them. `store.get` doubles as the SSR snapshot.
 */
export function useSelectedKeyframe(
  store: KeyframeSelectionStore,
): SelectedKeyframe | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
