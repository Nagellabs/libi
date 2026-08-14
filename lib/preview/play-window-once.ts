/** Minimal transport surface playWindowOnce needs (subset of TransportApi). */
export interface PlayWindowTransport {
  seek(frame: number): void;
  play(): void;
  pause(): void;
  frameStore: { get(): number; subscribe(cb: () => void): () => void };
}

/**
 * Seek to `startFrame`, play, and pause exactly once when the playhead reaches
 * `endFrame` (or scrubs back before `startFrame`). Returns a teardown that
 * cancels the watcher. No-op for a non-positive window. Extracted verbatim from
 * the former auto-play-after-edit effect so the seek/play/watch-pause behaviour
 * is unchanged — now reused by effect-preview-on-select.
 */
export function playWindowOnce(opts: {
  transport: PlayWindowTransport;
  startFrame: number;
  endFrame: number;
}): () => void {
  const { transport, startFrame, endFrame } = opts;
  if (endFrame <= startFrame) return () => {};

  let unsub: (() => void) | null = null;
  const teardown = () => {
    if (unsub) {
      unsub();
      unsub = null;
    }
  };

  transport.seek(startFrame);
  transport.play();
  const check = () => {
    const f = transport.frameStore.get();
    if (f >= endFrame || f < startFrame) {
      transport.pause();
      teardown();
    }
  };
  unsub = transport.frameStore.subscribe(check);
  return teardown;
}
