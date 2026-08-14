import { useState } from "react";

export interface EffectPreviewRequest {
  /** Monotonic — advances on EVERY request so an identical window still replays. */
  nonce: number;
  startSec: number;
  endSec: number;
}

export interface EffectPreviewStore {
  get(): EffectPreviewRequest | null;
  subscribe(cb: () => void): () => void;
  /** Ask the preview surface to play [startSec, endSec) once. */
  request(window: { startSec: number; endSec: number }): void;
}

export function createEffectPreviewStore(): EffectPreviewStore {
  let state: EffectPreviewRequest | null = null;
  let nonce = 0;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    request(window) {
      nonce += 1;
      state = { nonce, startSec: window.startSec, endSec: window.endSec };
      for (const cb of subs) cb();
    },
  };
}

/** Stable per-mount store instance — created once via a lazy useState
 *  initializer (the create-once idiom that doesn't read a ref during render);
 *  the setter is intentionally unused. */
export function useEffectPreviewStore(): EffectPreviewStore {
  const [store] = useState(createEffectPreviewStore);
  return store;
}
