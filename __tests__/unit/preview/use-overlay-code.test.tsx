// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useOverlayCompiledFns } from "@/hooks/preview/use-overlay-code";
import type { Composition, Overlay } from "@/lib/engine/types";

/**
 * The compile cache is state keyed on composition identity (recomputed during
 * render via the previous-state pattern). These tests pin the behaviors the
 * cache exists for: last-good retention across a broken edit, error surfacing,
 * and stability across identical composition references.
 */

function comp(overlays: Overlay[]): Composition {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    overlays,
    audioClips: [],
  } as unknown as Composition;
}

function codeOverlay(id: string, drawFunction: string): Overlay {
  return {
    id,
    kind: "code",
    drawFunction,
    startTime: 0,
    duration: 5,
    rect: { x: 0, y: 0, width: 100, height: 100 },
    z: 1,
  } as unknown as Overlay;
}

const GOOD = "ctx2d.fillRect(0, 0, 10, 10);";
const BROKEN = "this is not ( valid js";

describe("useOverlayCompiledFns", () => {
  it("compiles a code overlay and reports no error", () => {
    const { result } = renderHook(
      ({ c }: { c: Composition | null }) => useOverlayCompiledFns(c),
      { initialProps: { c: comp([codeOverlay("o1", GOOD)]) } },
    );
    expect(typeof result.current.compiledDrawFns.o1).toBe("function");
    expect(result.current.errors.o1).toBeUndefined();
  });

  it("keeps the last-good fn and surfaces the error when an edit breaks", () => {
    const { result, rerender } = renderHook(
      ({ c }: { c: Composition | null }) => useOverlayCompiledFns(c),
      { initialProps: { c: comp([codeOverlay("o1", GOOD)]) } },
    );
    const goodFn = result.current.compiledDrawFns.o1;
    expect(typeof goodFn).toBe("function");

    rerender({ c: comp([codeOverlay("o1", BROKEN)]) });
    // Broken edit: the previously-good fn is retained, the error is surfaced.
    expect(result.current.compiledDrawFns.o1).toBe(goodFn);
    expect(result.current.errors.o1).toBeTruthy();

    // Fixing the code clears the error and swaps in a fresh fn.
    rerender({ c: comp([codeOverlay("o1", GOOD)]) });
    expect(typeof result.current.compiledDrawFns.o1).toBe("function");
    expect(result.current.errors.o1).toBeUndefined();
  });

  it("returns the identical result object for the identical composition reference", () => {
    const c = comp([codeOverlay("o1", GOOD)]);
    const { result, rerender } = renderHook(
      ({ c }: { c: Composition | null }) => useOverlayCompiledFns(c),
      { initialProps: { c } },
    );
    const first = result.current;
    rerender({ c });
    expect(result.current).toBe(first);
  });

  it("drops cache entries for overlays that no longer exist", () => {
    const { result, rerender } = renderHook(
      ({ c }: { c: Composition | null }) => useOverlayCompiledFns(c),
      { initialProps: { c: comp([codeOverlay("o1", GOOD)]) } },
    );
    expect(result.current.compiledDrawFns.o1).toBeDefined();

    rerender({ c: comp([codeOverlay("o2", GOOD)]) });
    expect(result.current.compiledDrawFns.o1).toBeUndefined();
    expect(result.current.compiledDrawFns.o2).toBeDefined();

    // o1 was evicted: a BROKEN o1 now has no last-good to fall back to.
    rerender({ c: comp([codeOverlay("o1", BROKEN)]) });
    expect(result.current.compiledDrawFns.o1).toBeUndefined();
    expect(result.current.errors.o1).toBeTruthy();
  });

  it("clears everything on a null composition", () => {
    const { result, rerender } = renderHook(
      ({ c }: { c: Composition | null }) => useOverlayCompiledFns(c),
      { initialProps: { c: comp([codeOverlay("o1", GOOD)]) as Composition | null } },
    );
    rerender({ c: null });
    expect(result.current.compiledDrawFns).toEqual({});
    expect(result.current.errors).toEqual({});
  });
});
