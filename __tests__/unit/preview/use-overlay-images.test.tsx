// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useOverlayImages } from "@/hooks/preview/use-overlay-images";
import type { Composition, Overlay } from "@/lib/engine/types";

/**
 * The <img> cache is an external store published via useSyncExternalStore.
 * These tests pin its contract: reuse the SAME element across refetches while
 * (overlay.id, fileId) is stable, swap on fileId change, drop removed
 * overlays, and clear on a null composition.
 */

function imageOverlay(id: string, fileId: string): Overlay {
  return {
    id,
    kind: "image",
    fileId,
    startTime: 0,
    duration: 5,
    rect: { x: 0, y: 0, width: 100, height: 100 },
    z: 1,
  } as unknown as Overlay;
}

function comp(overlays: Overlay[]): Composition {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    overlays,
    audioClips: [],
  } as unknown as Composition;
}

describe("useOverlayImages", () => {
  it("creates one <img> per image overlay, keyed by overlay id", () => {
    const { result } = renderHook(({ c }: { c: Composition | null }) => useOverlayImages(c), {
      initialProps: { c: comp([imageOverlay("o1", "f1")]) },
    });
    expect(result.current.images.o1).toBeInstanceOf(HTMLImageElement);
    expect(result.current.images.o1.src).toContain("/api/files/by-id/f1/content");
  });

  it("reuses the SAME element across a refetch with an identical (id, fileId)", () => {
    const { result, rerender } = renderHook(
      ({ c }: { c: Composition | null }) => useOverlayImages(c),
      { initialProps: { c: comp([imageOverlay("o1", "f1")]) } },
    );
    const first = result.current.images.o1;
    // A fresh composition object (SSE refetch) with the same pairs.
    rerender({ c: comp([imageOverlay("o1", "f1")]) });
    expect(result.current.images.o1).toBe(first);
  });

  it("swaps the element when the overlay's fileId changes", () => {
    const { result, rerender } = renderHook(
      ({ c }: { c: Composition | null }) => useOverlayImages(c),
      { initialProps: { c: comp([imageOverlay("o1", "f1")]) } },
    );
    const first = result.current.images.o1;
    rerender({ c: comp([imageOverlay("o1", "f2")]) });
    expect(result.current.images.o1).not.toBe(first);
    expect(result.current.images.o1.src).toContain("/api/files/by-id/f2/content");
  });

  it("drops overlays that no longer exist and clears on null", () => {
    const { result, rerender } = renderHook(
      ({ c }: { c: Composition | null }) => useOverlayImages(c),
      {
        initialProps: {
          c: comp([imageOverlay("o1", "f1"), imageOverlay("o2", "f2")]) as Composition | null,
        },
      },
    );
    expect(Object.keys(result.current.images).sort()).toEqual(["o1", "o2"]);

    rerender({ c: comp([imageOverlay("o2", "f2")]) });
    expect(Object.keys(result.current.images)).toEqual(["o2"]);

    rerender({ c: null });
    expect(result.current.images).toEqual({});
  });
});
