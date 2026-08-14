/**
 * The active guided-edit highlight, held OUTSIDE React (mirrors
 * `lib/preview/selection-store.ts`). The preview surface sets it when a
 * `libi.highlight_property` event arrives; the inspector subscribes via
 * `useSyncExternalStore` so the matching `<TierField>` flashes. The value
 * auto-clears after a TTL so the flash is transient.
 *
 * The timer is injectable (`setTimeoutFn` / `clearTimeoutFn`) purely so the
 * unit test can drive a deterministic clock; production uses the globals.
 */

import {
  defaultGroupForKind,
  groupForField,
  type InspectorGroup,
  type InspectorOverlayKind,
} from "@/lib/overlays/inspector-fields";

export interface HighlightValue {
  overlayId: string;
  property: string;
  note?: string;
}

export interface HighlightStore {
  /** Active highlight, or null. Snapshot for useSyncExternalStore. */
  get(): HighlightValue | null;
  /** Set the highlight; auto-clears after `ttlMs` (default 4000). Pass 0 to disable auto-clear. */
  set(value: HighlightValue | null, ttlMs?: number): void;
  /** Subscribe to changes; returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void;
}

const DEFAULT_TTL_MS = 4000;

export interface HighlightStoreDeps {
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export function createHighlightStore(deps: HighlightStoreDeps = {}): HighlightStore {
  const setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));

  let current: HighlightValue | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const l of listeners) l();
  };

  return {
    get: () => current,
    set: (value, ttlMs = DEFAULT_TTL_MS) => {
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
      current = value;
      notify();
      if (value !== null && ttlMs > 0) {
        timer = setTimeoutFn(() => {
          timer = null;
          current = null;
          notify();
        }, ttlMs);
      }
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

/**
 * Pure decision used when applying a highlight: given the targeted field key
 * and the targeted overlay's KIND, return the tab (intent group) the overlay's
 * inspector should switch to so the field is visible — the field's exact group
 * for that kind, falling back to the kind's default group when the field is
 * unknown or not applicable to the kind.
 */
export function targetGroupForHighlight(
  property: string,
  kind: InspectorOverlayKind,
): InspectorGroup {
  return groupForField(property, kind) ?? defaultGroupForKind(kind);
}
