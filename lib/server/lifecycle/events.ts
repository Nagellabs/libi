import { serverLogger as logger } from "@/lib/logger";
import type { LifecycleEvent } from "./types";

type Listener = (event: LifecycleEvent) => void;

// HMR-safe singleton mirroring lib/db/client.ts.
const globalSlot = globalThis as unknown as {
  __libiLifecycleEvents?: { listeners: Set<Listener> };
};
if (!globalSlot.__libiLifecycleEvents) {
  globalSlot.__libiLifecycleEvents = { listeners: new Set() };
}
const slot = globalSlot.__libiLifecycleEvents;

export const lifecycleEvents = {
  /** Subscribe. Returns an unsubscribe function. */
  on(listener: Listener): () => void {
    slot.listeners.add(listener);
    return () => slot.listeners.delete(listener);
  },
  /** Synchronously dispatch to every listener. One throwing listener does
   *  not abort the rest — errors are logged. */
  emit(event: LifecycleEvent): void {
    for (const fn of slot.listeners) {
      try {
        fn(event);
      } catch (err) {
        logger.warn({ err }, "lifecycle.listener_threw");
      }
    }
  },
};

/** Test-only escape hatch. */
export function __resetLifecycleEventsForTests(): void {
  slot.listeners.clear();
}
