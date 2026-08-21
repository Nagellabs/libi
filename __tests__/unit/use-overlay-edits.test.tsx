// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMergedOverlayEdits } from "@/hooks/preview/use-overlay-edits";
import { createOverlayEditStore } from "@/lib/preview/overlay-edit-store";
import type { Composition, TextOverlay } from "@/lib/engine/types";

function makeComp(overlays: TextOverlay[]): Composition {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    overlays,
  } as unknown as Composition;
}

function textOverlay(id: string, x: number): TextOverlay {
  return {
    id,
    kind: "text",
    startTime: 0,
    duration: 5,
    z: 0,
    rect: { x, y: 0, width: 100, height: 50 },
    text: "hi",
  } as unknown as TextOverlay;
}

describe("useMergedOverlayEdits", () => {
  it("returns the server composition unchanged (identity) when there are no edits", () => {
    const store = createOverlayEditStore();
    const comp = makeComp([textOverlay("a", 10)]);
    const { result } = renderHook(() => useMergedOverlayEdits(comp, store));
    expect(result.current).toBe(comp); // identity-stable, behavior-neutral
  });

  it("returns null when composition is null", () => {
    const store = createOverlayEditStore();
    const { result } = renderHook(() => useMergedOverlayEdits(null, store));
    expect(result.current).toBeNull();
  });

  it("merges a pending edit and re-renders on store change", () => {
    const store = createOverlayEditStore();
    const comp = makeComp([textOverlay("a", 10)]);
    const { result } = renderHook(() => useMergedOverlayEdits(comp, store));
    expect(result.current).toBe(comp);

    act(() => {
      store.commit("a", { rect: { x: 99, y: 0, width: 100, height: 50 } });
    });

    expect(result.current).not.toBe(comp);
    const merged = result.current!;
    expect(merged.overlays![0].rect.x).toBe(99);
    // server composition is never mutated
    expect(comp.overlays![0].rect.x).toBe(10);
  });

  it("keeps a STABLE merged-composition identity across re-renders while a committed edit is pending", () => {
    // Regression guard for the "Maximum update depth exceeded" loop: while a
    // committed edit is pending, a parent re-render (here, the rerender() call)
    // must NOT rebuild the merged composition — else every downstream
    // useEffect([composition]) fires each render and can spin.
    const store = createOverlayEditStore();
    const comp = makeComp([textOverlay("a", 10)]);
    const { result, rerender } = renderHook(() => useMergedOverlayEdits(comp, store));

    act(() => {
      store.commit("a", { rect: { x: 99, y: 0, width: 100, height: 50 } });
    });
    const mergedAfterCommit = result.current;
    expect(mergedAfterCommit).not.toBe(comp);

    // A re-render with no store change returns the SAME reference (memoized).
    rerender();
    expect(result.current).toBe(mergedAfterCommit);

    // A PREVIEW write (imperative-only) is invisible to React — still the same
    // reference, no recompute.
    act(() => {
      store.preview("a", { opacity: 0.45 });
    });
    rerender();
    expect(result.current).toBe(mergedAfterCommit);
  });

  it("drops a committed override ONLY once the composition reflects it (data-gated reconcile)", () => {
    // The residual fast/repeated-drag flash fix: the override must persist while
    // the composition is stale (masking it), and drop only when the rendered
    // composition's overlay provably carries the patch — never on a timer.
    const store = createOverlayEditStore();
    const { result, rerender } = renderHook(
      ({ comp }: { comp: Composition }) => useMergedOverlayEdits(comp, store),
      { initialProps: { comp: makeComp([textOverlay("a", 10)]) } },
    );

    // Commit a move to x:99. The override masks the still-origin composition.
    act(() => {
      store.commit("a", { rect: { x: 99, y: 0, width: 100, height: 50 } });
    });
    expect(result.current!.overlays![0].rect.x).toBe(99);
    expect(store.getCommitted().has("a")).toBe(true);

    // A STALE refetch arrives — composition still at origin (x:10). The override
    // must NOT drop (dropping here is the flash); it keeps masking the stale x:10.
    act(() => {
      rerender({ comp: makeComp([textOverlay("a", 10)]) });
    });
    expect(store.getCommitted().has("a")).toBe(true);
    expect(result.current!.overlays![0].rect.x).toBe(99);

    // The real save lands — composition now reflects x:99. The reconciler drops
    // the override (same value ⇒ no visual change), and getCommitted empties.
    act(() => {
      rerender({ comp: makeComp([textOverlay("a", 99)]) });
    });
    expect(store.getCommitted().has("a")).toBe(false);
    expect(result.current!.overlays![0].rect.x).toBe(99);
  });

  it("does NOT drop a committed override the composition reflects at an OLDER value while a newer edit is pending", () => {
    // Repeated dragging: a second drag commits x:200 while the server only
    // reflects the first drag's x:99. The override (x:200) must stay until the
    // composition reflects 200 — the stale x:99 reflection must not drop it.
    const store = createOverlayEditStore();
    const { result, rerender } = renderHook(
      ({ comp }: { comp: Composition }) => useMergedOverlayEdits(comp, store),
      { initialProps: { comp: makeComp([textOverlay("a", 10)]) } },
    );
    act(() => {
      store.commit("a", { rect: { x: 200, y: 0, width: 100, height: 50 } });
    });
    // Composition reflects the PREVIOUS drag (x:99), not the current one (x:200).
    act(() => {
      rerender({ comp: makeComp([textOverlay("a", 99)]) });
    });
    expect(store.getCommitted().has("a")).toBe(true); // not dropped — value differs
    expect(result.current!.overlays![0].rect.x).toBe(200); // override still masks
  });
});
