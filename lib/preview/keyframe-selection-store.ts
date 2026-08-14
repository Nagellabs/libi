/**
 * The currently-selected keyframe `{ overlayId, t }`, held OUTSIDE React so
 * selecting a diamond never re-renders the editor page. Mirrors
 * `lib/preview/frame-store.ts` / `lib/preview/selection-store.ts`: display
 * components subscribe via `useSelectedKeyframe`; everything else reads it
 * imperatively. One store per `PreviewSurface`.
 *
 * `t` is the keyframe's NORMALIZED time (0→1 within the overlay window) — the
 * same value `overlayKeyframeTimes(overlay)` returns and the store on disk uses.
 * Phase 6's curve editor consumes this selection; Phase 5a only SETs it on a
 * diamond click and clears it (deselect / piece switch).
 */
export interface SelectedKeyframe {
  overlayId: string;
  /** Normalized keyframe time 0→1 within the overlay window. */
  t: number;
}

export interface KeyframeSelectionStore {
  /** The selected keyframe, or null. Snapshot for useSyncExternalStore. */
  get(): SelectedKeyframe | null;
  /** Replace the selection (or clear it with null). Notifies only on a real
   *  content change (same overlayId + same t is a no-op). */
  set(next: SelectedKeyframe | null): void;
  /** Subscribe to changes; returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void;
}

/** Stable identity string for a selection, e.g. `"ov1@0.25"` (or `""` for null).
 *  The single source for the auto-open guards so the surface (opens the panel)
 *  and the panel (switches to the Keyframes tab) can't derive drifting keys. */
export function keyframeSelectionKey(sel: SelectedKeyframe | null): string {
  return sel ? `${sel.overlayId}@${sel.t}` : "";
}

function same(a: SelectedKeyframe | null, b: SelectedKeyframe | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.overlayId === b.overlayId && a.t === b.t;
}

export function createKeyframeSelectionStore(
  initial: SelectedKeyframe | null = null,
): KeyframeSelectionStore {
  let selected = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => selected,
    set: (next) => {
      if (same(next, selected)) return;
      selected = next;
      for (const l of listeners) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}
