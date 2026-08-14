"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { frameFromClientX } from "@/lib/preview/playhead-drag";

/** Pointer-capture scrub shared by the playhead strip surface and the
 *  spanning playhead line: pointerdown seeks and starts a drag, move
 *  follows the pointer, up/cancel releases. The laneRef element defines
 *  the x-origin so every surface maps clientX identically.
 *
 *  Moves are COALESCED to one seek per animation frame (latest pointer
 *  position wins) and DEDUPED by target frame. Every seek is a hard seek
 *  downstream (decoder flush + re-decode of all mounted video sources) —
 *  a real drag delivers 60–120 pointermoves/sec, and issuing a seek per
 *  move built a backlog that replayed serially and froze the playhead for
 *  hundreds of ms on video-heavy pieces. rAF back-pressures naturally: a
 *  busy main thread just means the next seek uses a fresher position. */
export function usePlayheadScrub(args: {
  laneRef: RefObject<HTMLDivElement | null>;
  totalFrames: number;
  onScrub: (frame: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
}) {
  const { laneRef, totalFrames, onScrub, onDraggingChange } = args;
  const draggingRef = useRef(false);
  const lastFrameRef = useRef<number | null>(null);
  const pendingXRef = useRef<number | null>(null);
  const rafRef = useRef(0);

  const scrub = useCallback(
    (clientX: number) => {
      const lane = laneRef.current;
      if (!lane) return;
      const rect = lane.getBoundingClientRect();
      const frame = frameFromClientX({
        clientX,
        laneLeft: rect.left,
        laneWidth: rect.width,
        totalFrames,
      });
      // Same target frame ⇒ skip: the seek itself is idempotent but bumping
      // the seek signal re-flushes every video decoder.
      if (frame === lastFrameRef.current) return;
      lastFrameRef.current = frame;
      onScrub(frame);
    },
    [laneRef, totalFrames, onScrub],
  );
  // The rAF callback must see the LATEST scrub (totalFrames/onScrub can
  // change identity mid-drag) — same latest-ref pattern as timeline.tsx's
  // wheel handler.
  const scrubRef = useRef(scrub);
  useEffect(() => {
    scrubRef.current = scrub;
  });

  /** Run the coalesced pending move now (drag end / next animation frame). */
  const flushPending = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    const x = pendingXRef.current;
    pendingXRef.current = null;
    if (x != null) scrubRef.current(x);
  }, []);

  const stopDragging = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    onDraggingChange?.(false);
  }, [onDraggingChange]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Primary button (or touch/pen contact) only — a right-click must not
      // scrub or latch the drag, and must keep its context menu.
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      draggingRef.current = true;
      lastFrameRef.current = null; // a fresh press always seeks
      pendingXRef.current = null;
      onDraggingChange?.(true);
      scrubRef.current(e.clientX); // immediate — a click-seek must not wait a frame
    },
    [onDraggingChange],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!draggingRef.current) return;
      // A lost pointerup (released outside the window, failed capture,
      // synthetic events) would leave the latch stuck and a bare hover would
      // scrub. No button held ⇒ the drag is over: self-heal, never follow.
      if (e.buttons === 0) {
        pendingXRef.current = null;
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        stopDragging();
        return;
      }
      pendingXRef.current = e.clientX;
      if (rafRef.current) return; // one seek per animation frame
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        if (!draggingRef.current) {
          pendingXRef.current = null;
          return;
        }
        const x = pendingXRef.current;
        pendingXRef.current = null;
        if (x != null) scrubRef.current(x);
      });
    },
    [stopDragging],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!draggingRef.current) return;
      flushPending(); // release lands exactly where the pointer was
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
      stopDragging();
    },
    [flushPending, stopDragging],
  );

  // Unmount mid-drag: drop the scheduled frame so it can't fire into a dead tree.
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  };
}
