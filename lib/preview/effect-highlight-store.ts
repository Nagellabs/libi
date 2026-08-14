/**
 * The active effects guided-edit highlight, held OUTSIDE React (mirrors
 * `lib/preview/highlight-store.ts`). The preview surface sets it when a
 * `libi.highlight_effect` event arrives; the effects panel + inspector
 * subscribe via `useSyncExternalStore` so the matching thumbnail / slot
 * flashes. The value auto-clears after a TTL so the flash is transient.
 *
 * The timer is injectable (`setTimeoutFn` / `clearTimeoutFn`) purely so the
 * unit test can drive a deterministic clock; production uses the globals.
 */

"use client";

import { useSyncExternalStore } from "react";
import type { EffectPhase } from "@/lib/effects/types";

export type EffectHighlightValue =
  | { kind: "catalog"; effectId: string; phase?: EffectPhase; note?: string }
  | { kind: "applied"; layerId: string; phase: EffectPhase; note?: string };

export interface EffectHighlightStore {
  /** Active highlight, or null. Snapshot for useSyncExternalStore. */
  get(): EffectHighlightValue | null;
  /** Set the highlight; auto-clears after `ttlMs` (default 4000). Pass 0 to disable auto-clear. */
  set(value: EffectHighlightValue | null, ttlMs?: number): void;
  /** Subscribe to changes; returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void;
}

const DEFAULT_TTL_MS = 4000;

export interface EffectHighlightStoreDeps {
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export function createEffectHighlightStore(
  deps: EffectHighlightStoreDeps = {},
): EffectHighlightStore {
  const setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));

  let current: EffectHighlightValue | null = null;
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

/** Subscribe a component to the active effect-highlight value (for thumbnail / slot flash). */
export function useEffectHighlightValue(
  store: EffectHighlightStore,
): EffectHighlightValue | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
