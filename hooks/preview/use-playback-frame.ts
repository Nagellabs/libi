"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { FrameStore } from "@/lib/preview/frame-store";

const NOOP_SUBSCRIBE = () => () => {};
const ZERO_SNAPSHOT = () => 0;

/**
 * Subscribe a component to the playhead frame. ONLY components that visually
 * track the playhead (the preview canvas, the timeline scrubber, the frame
 * counter) should call this — that is what keeps the 30 Hz re-render scoped to
 * them instead of the whole editor. `store.get` doubles as the server snapshot
 * (returns the initial frame during SSR; the editor is client-only anyway).
 *
 * `enabled` (default true) lets a component that only SOMETIMES needs the live
 * frame opt out of the 30 Hz re-render in the states where it doesn't. When
 * false, the subscription is a no-op and the snapshot is a constant 0, so the
 * component never re-renders from the frame store. This is how the inspector
 * panel avoids re-rendering every frame during playback while an overlay is
 * selected (it only needs the live frame to describe the scene-under-playhead
 * when NOTHING is selected) — the measured cause of the post-edit GC stutter.
 * See docs-local/superpowers/notes/smoothness-fixture.md.
 */
export function usePlaybackFrame(store: FrameStore, enabled = true): number {
  const subscribe = useMemo(
    () => (enabled ? store.subscribe : NOOP_SUBSCRIBE),
    [store, enabled],
  );
  const getSnapshot = useMemo(
    () => (enabled ? store.get : ZERO_SNAPSHOT),
    [store, enabled],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
