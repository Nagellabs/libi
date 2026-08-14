"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { Composition } from "@/lib/engine/types";
import type {
  OverlayEditStore,
  OverlayEditEntry,
} from "@/lib/preview/overlay-edit-store";
import { mergeOverlayEdits } from "@/lib/preview/overlay-edit-merge";
import { reflectsPatch } from "@/lib/overlays/use-optimistic-overlay";

/** Subscribe to the edit store and return the server composition with pending
 *  COMMITTED local edits merged in. Identity-stable when there are no committed
 *  edits.
 *
 *  This consumes ONLY the committed channel: `store.subscribe` fires solely on
 *  committed changes, and we merge `store.getCommitted()` — preview-phase edits
 *  are invisible to React (only the imperative canvas path sees them), so
 *  PreviewSurface never re-renders mid-gesture.
 *
 *  **Identity stability matters.** `store.getCommitted()` returns the SAME Map
 *  reference until a committed change rebuilds it, so it is a valid
 *  `useSyncExternalStore` snapshot. The merged composition is then `useMemo`'d
 *  on `[composition, committed]`, so re-renders triggered by anything OTHER than
 *  a real committed change (a parent re-render, a sibling effect's setState)
 *  return the SAME merged-composition reference. Without that memo,
 *  `mergeOverlayEdits` rebuilt a new composition object on every render while a
 *  committed edit was pending, which made every downstream `useEffect(…,
 *  [composition])` (e.g. `useOverlayThreeScenes`) fire each render and could
 *  spin into a "Maximum update depth exceeded" loop. `mergeOverlayEdits`
 *  returns the composition unchanged when the committed map is empty, so this
 *  stays behavior-neutral while no committed edits exist. */
export function useMergedOverlayEdits(
  composition: Composition | null,
  store: OverlayEditStore,
): Composition | null {
  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe(onChange),
    [store],
  );
  // getCommitted() is a cached Map reference (a new identity only on a committed
  // change), so it is a stable snapshot useSyncExternalStore can compare.
  const getCommitted = useCallback(
    (): ReadonlyMap<string, OverlayEditEntry> => store.getCommitted(),
    [store],
  );
  const committed = useSyncExternalStore(subscribe, getCommitted, getCommitted);

  // Data-gated reconcile (the residual drag origin-flash fix). A committed
  // override is dropped ONLY once the incoming SERVER composition's overlay
  // already reflects the patch — never on a version/timer. This closes the race
  // where the old `confirm()` dropped the override the instant the PATCH
  // resolved, but the React-Query-derived composition rebuild that should carry
  // the value was a SEPARATE async update landing a render or two later (or a
  // stale `refresh_query` refetch from an EARLIER drag briefly returned the
  // PREVIOUS position). Keeping the override until `composition` provably holds
  // the value means there is never a frame where neither side has it, so the
  // merge always paints the destination — and a stale intermediate refetch is
  // masked instead of flashing. `store.confirm(id, entry.version)` drops only
  // when no newer commit superseded the entry (version gate), so an in-flight
  // re-drag is never dropped early.
  useEffect(() => {
    if (committed.size === 0 || !composition?.overlays) return;
    for (const [id, entry] of committed) {
      const ov = composition.overlays.find((o) => o.id === id) as
        | Record<string, unknown>
        | undefined;
      if (ov && reflectsPatch(ov, entry.patch as Record<string, unknown>)) {
        store.confirm(id, entry.version);
      }
    }
  }, [composition, committed, store]);

  return useMemo(
    () => mergeOverlayEdits(composition, committed),
    [composition, committed],
  );
}
