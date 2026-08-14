import type { Overlay } from "@/lib/engine/types";

export type EditPhase = "preview" | "committed";

export interface OverlayEditEntry {
  patch: Partial<Overlay>;
  version: number;
  phase: EditPhase;
}

export interface OverlayEditStoreOptions {
  /**
   * Optional frame scheduler (e.g. `requestAnimationFrame`). When provided,
   * repeated imperative fires within one scheduled window coalesce into a
   * single imperative-listener invocation. When omitted, imperative fires
   * happen synchronously (default — unit tests / SSR / no-rAF).
   */
  scheduler?: (cb: () => void) => void;
}

export interface OverlayEditStore {
  /** All in-flight entries (both `preview` and `committed` phases). Live map. */
  getAll(): ReadonlyMap<string, OverlayEditEntry>;
  /** Only `committed` entries — the React-visible merge view (new identity per committed change). */
  getCommitted(): ReadonlyMap<string, OverlayEditEntry>;
  /** Merge `patch` into a `preview`-phase entry; bumps version. Fires imperative channel only. */
  preview(overlayId: string, patch: Partial<Overlay>): void;
  /** Merge `patch`, flip to `committed`, bump version. Fires BOTH channels. Returns the new version. */
  commit(overlayId: string, patch?: Partial<Overlay>): number;
  /** Drop a `committed` entry iff serverVersion >= entry.version. Fires both channels on change. */
  confirm(overlayId: string, serverVersion: number): void;
  /** Drop a `preview` entry. Fires imperative channel only (a preview was never React-visible). */
  cancelPreview(overlayId: string): void;
  /** Fired on EVERY write (canvas repaints imperatively; no React re-render). */
  subscribeImperative(cb: () => void): () => void;
  /** Fired ONLY on committed changes (React merge path). */
  subscribe(cb: () => void): () => void;
}

export function createOverlayEditStore(
  options: OverlayEditStoreOptions = {},
): OverlayEditStore {
  const { scheduler } = options;
  const entries = new Map<string, OverlayEditEntry>();
  const impListeners = new Set<() => void>();
  const reactListeners = new Set<() => void>();

  // React-visible snapshot — rebuilt to a NEW Map identity on every committed
  // change so `useSyncExternalStore` consumers detect the change by reference.
  let committedView: ReadonlyMap<string, OverlayEditEntry> = new Map();
  const rebuildCommittedView = () => {
    const next = new Map<string, OverlayEditEntry>();
    for (const [id, entry] of entries) {
      if (entry.phase === "committed") next.set(id, entry);
    }
    committedView = next;
  };

  let scheduled = false;
  const fireImp = () => {
    if (!scheduler) {
      for (const l of impListeners) l();
      return;
    }
    if (scheduled) return;
    scheduled = true;
    scheduler(() => {
      scheduled = false;
      for (const l of impListeners) l();
    });
  };
  const fireReact = () => {
    for (const l of reactListeners) l();
  };

  const commit = (id: string, patch?: Partial<Overlay>): number => {
    const prev = entries.get(id);
    const version = (prev?.version ?? 0) + 1;
    entries.set(id, {
      patch: { ...(prev?.patch ?? {}), ...(patch ?? {}) } as Partial<Overlay>,
      version,
      phase: "committed",
    });
    rebuildCommittedView();
    fireImp();
    fireReact();
    return version;
  };

  return {
    getAll: () => entries,
    getCommitted: () => committedView,
    preview: (id, patch) => {
      const prev = entries.get(id);
      const version = (prev?.version ?? 0) + 1;
      entries.set(id, {
        patch: { ...(prev?.patch ?? {}), ...patch } as Partial<Overlay>,
        version,
        phase: "preview",
      });
      fireImp();
    },
    commit,
    confirm: (id, serverVersion) => {
      const e = entries.get(id);
      if (!e || e.phase !== "committed") return;
      if (serverVersion >= e.version) {
        entries.delete(id);
        rebuildCommittedView();
        fireImp();
        fireReact();
      }
    },
    cancelPreview: (id) => {
      const e = entries.get(id);
      if (!e || e.phase !== "preview") return;
      entries.delete(id);
      fireImp();
    },
    subscribeImperative: (l) => {
      impListeners.add(l);
      return () => { impListeners.delete(l); };
    },
    subscribe: (l) => {
      reactListeners.add(l);
      return () => { reactListeners.delete(l); };
    },
  };
}
