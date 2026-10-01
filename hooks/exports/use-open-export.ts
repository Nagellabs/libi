"use client";

/**
 * "Open this export": switch to a piece's Exports tab, optionally on one
 * export — from the resources panel's Exports folder (and Part B's finish
 * toast). UI-local, like hooks/social/use-posting-intent.ts. An intent made
 * while the editor page is not mounted is parked and claimed when it mounts.
 */
export interface OpenExportIntent {
  pieceId: string;
  exportId: string | null;
  nonce: number;
}

type Listener = (intent: OpenExportIntent) => void;

const g = globalThis as unknown as {
  __libiOpenExport?: { pending: OpenExportIntent | null; listeners: Set<Listener>; nonce: number };
};
const store = (g.__libiOpenExport ??= { pending: null, listeners: new Set(), nonce: 0 });

export function openExportInTab(target: { pieceId: string; exportId?: string | null }): void {
  const intent: OpenExportIntent = { pieceId: target.pieceId, exportId: target.exportId ?? null, nonce: ++store.nonce };
  if (store.listeners.size === 0) {
    store.pending = intent;
    return;
  }
  store.pending = null;
  for (const listener of store.listeners) listener(intent);
}

/** The editor page's subscription. A parked intent is delivered on the next microtask, never inside the caller's effect. */
export function subscribeOpenExport(listener: Listener): () => void {
  store.listeners.add(listener);
  const pending = store.pending;
  store.pending = null;
  if (pending) queueMicrotask(() => listener(pending));
  return () => {
    store.listeners.delete(listener);
  };
}
