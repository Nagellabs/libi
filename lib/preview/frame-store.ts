/**
 * The playhead frame, held OUTSIDE React so the 30 Hz rAF advance never
 * re-renders the editor tree. Components that display the playhead subscribe
 * via `usePlaybackFrame` (useSyncExternalStore); everything else reads it
 * imperatively with `get()`. One store per `useTransport` instance.
 */
export interface FrameStore {
  /** Current playhead frame (integer). Snapshot for useSyncExternalStore. */
  get(): number;
  /** Set the frame; notifies subscribers only when the value actually changes. */
  set(frame: number): void;
  /** Subscribe to changes; returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void;
}

export function createFrameStore(initial = 0): FrameStore {
  let frame = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => frame,
    set: (next) => {
      if (next === frame) return;
      frame = next;
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

/**
 * A discrete USER-seek/scrub signal, also OUTSIDE React. The transport `bump()`s
 * it on every user seek (transport.seek / scrub) so the video-source layer can
 * HARD-seek (flush + re-decode) the mounted sources — distinct from the 30 Hz
 * playback frame advance (which must stay SOFT). It carries the seek's target
 * frame so the subscriber doesn't have to read the (already-updated) frame store
 * separately. Kept as a counter so identical-frame seeks (e.g. re-clicking the
 * same playhead) still fire.
 */
export interface SeekSignalStore {
  /** Monotonic epoch — bumps on every user seek. Snapshot for subscribers. */
  epoch(): number;
  /** The target frame of the most recent user seek. */
  frame(): number;
  /** Record a user seek to `frame` and notify subscribers. */
  bump(frame: number): void;
  subscribe(listener: () => void): () => void;
}

export function createSeekSignalStore(): SeekSignalStore {
  let epoch = 0;
  let frame = 0;
  const listeners = new Set<() => void>();
  return {
    epoch: () => epoch,
    frame: () => frame,
    bump: (f) => {
      epoch += 1;
      frame = f;
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
