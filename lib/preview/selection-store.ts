/**
 * The currently-selected overlay/scene/clip ids, held OUTSIDE React so selecting
 * never re-renders the editor page. Mirrors `lib/preview/frame-store.ts`: display
 * components subscribe via `useSelectedOverlay` (the primary) or
 * `useSelectedOverlayIds` (the whole ordered set); everything else reads it
 * imperatively. One store per `PreviewSurface`.
 *
 * Selection is an ORDERED SET (`string[]`). The single-id surface (`get`/`set`)
 * is preserved for back-compat — `get()` returns the PRIMARY (`selected[0]`) and
 * `set(id)` collapses to a single-id (or empty) selection.
 */
export interface SelectionStore {
  /** Primary selected id (selected[0]), or null. Snapshot for useSyncExternalStore. */
  get(): string | null;
  /** Replace the selection with a single id (or clear it). */
  set(id: string | null): void;
  /** The full ordered selection. Stable reference until contents change. */
  getAll(): string[];
  /** Replace the whole ordered selection; notifies only on a real content change. */
  setAll(ids: string[]): void;
  /** Primary selected id (selected[0]), or null. */
  primary(): string | null;
  /** Add the id if absent, remove it if present (preserving order). */
  toggle(id: string): void;
  /** Subscribe to changes; returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void;
}

function sameContents(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function createSelectionStore(initial: string | null = null): SelectionStore {
  // `selected` is the stable snapshot returned by getAll — replaced (not mutated)
  // only when contents actually change, so useSyncExternalStore stays stable.
  let selected: string[] = initial != null ? [initial] : [];
  const listeners = new Set<() => void>();

  const setAll = (ids: string[]) => {
    if (sameContents(ids, selected)) return;
    selected = ids.slice();
    for (const l of listeners) l();
  };

  return {
    get: () => selected[0] ?? null,
    primary: () => selected[0] ?? null,
    getAll: () => selected,
    setAll,
    set: (id) => setAll(id != null ? [id] : []),
    toggle: (id) =>
      setAll(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]),
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}
