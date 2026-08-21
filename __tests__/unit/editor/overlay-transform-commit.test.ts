// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import {
  useOverlayTransformCommit,
  type OverlayTransformPatch,
  type AutoKeyframeConfig,
} from "@/hooks/editor/use-overlay-transform-commit";
import {
  createOverlayEditStore,
  type OverlayEditStore,
} from "@/lib/preview/overlay-edit-store";
import { pieceKeys } from "@/lib/queries/pieces";

function mkResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch mock whose calls are typed `[input, init?]` so indexing is sound. */
function fetchReturning(status: number, body: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    mkResponse(status, body),
  );
}

/**
 * Render the hook with a real QueryClient + a real OverlayEditStore. Returns
 * the hook result plus the store + qc so assertions can inspect both.
 */
function setup(pieceId: string | null = "p1") {
  const store: OverlayEditStore = createOverlayEditStore();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Seed the composition cache so the success-path cache update has something
  // to mutate (overlays live at manifest.overlays).
  qc.setQueryData(pieceKeys.composition("p1"), {
    manifest: {
      width: 1920,
      height: 1080,
      fps: 30,
      overlays: [
        {
          id: "o1",
          kind: "text",
          rect: { x: 0, y: 0, width: 100, height: 30 },
          startTime: 0,
          duration: 1,
          z: 0,
        },
        {
          id: "o2",
          kind: "text",
          background: { color: "#000" },
          rect: { x: 0, y: 0, width: 100, height: 30 },
          startTime: 0,
          duration: 1,
          z: 0,
        },
      ],
    },
    audioClips: [],
  });

  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);

  const { result } = renderHook(
    () => useOverlayTransformCommit(pieceId, store),
    { wrapper },
  );
  return { result, store, qc };
}

function cachedOverlay(qc: QueryClient, id: string) {
  const data = qc.getQueryData(pieceKeys.composition("p1")) as
    | { manifest: { overlays?: Array<Record<string, unknown>> } }
    | undefined;
  return data?.manifest.overlays?.find((o) => o.id === id);
}

/** The committed-phase entry for an overlay, or undefined. The new store has no
 *  `get` — committed edits surface via `getCommitted()` (the React merge view). */
function committed(store: OverlayEditStore, id: string) {
  return store.getCommitted().get(id);
}

describe("useOverlayTransformCommit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("commit flips the entry to committed synchronously (paints before any timer)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result, store } = setup();

    act(() => {
      result.current.commit("o1", { opacity: 45 });
    });

    // Store has the patch in the COMMITTED (React-visible) phase immediately,
    // before the debounce elapses.
    const entry = committed(store, "o1");
    expect(entry?.patch).toEqual({ opacity: 45 });
    expect(entry?.phase).toBe("committed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("debounces + coalesces: no PATCH before the window, exactly one cumulative PATCH after", async () => {
    const fetchMock = fetchReturning(200, { version: 1 });
    vi.stubGlobal("fetch", fetchMock);
    const { result, store } = setup();

    act(() => {
      result.current.commit("o1", { opacity: 10 });
    });
    // Re-commit quickly (within the debounce) — should reset the timer + merge.
    act(() => {
      vi.advanceTimersByTime(100);
      result.current.commit("o1", { rect: { x: 5, y: 6, width: 7, height: 8 } });
    });

    // Still inside the (reset) window — no PATCH yet.
    expect(fetchMock).not.toHaveBeenCalled();

    // The store merged both patches into one cumulative committed entry.
    expect(committed(store, "o1")?.patch).toEqual({
      opacity: 10,
      rect: { x: 5, y: 6, width: 7, height: 8 },
    });

    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      opacity: 10,
      rect: { x: 5, y: 6, width: 7, height: 8 },
    });
  });

  it("flush forces the PATCH immediately (before the debounce elapses)", async () => {
    const fetchMock = fetchReturning(200, { version: 1 });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = setup();

    act(() => {
      result.current.commit("o1", { opacity: 30 });
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      result.current.flush("o1");
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(url).toBe("/api/pieces/p1/overlays/o1");
    expect(JSON.parse(init.body as string)).toEqual({
      opacity: 30,
    });
  });

  it("on ok PATCH: cache is updated; the override PERSISTS (the reconciler owns the drop)", async () => {
    const fetchMock = fetchReturning(200, { version: 9 });
    vi.stubGlobal("fetch", fetchMock);
    const { result, store, qc } = setup();

    act(() => {
      result.current.commit("o1", { opacity: 33 });
    });

    await act(async () => {
      result.current.flush("o1");
      await Promise.resolve();
      await Promise.resolve();
    });

    // Cache reflects the saved patch + version.
    const ov = cachedOverlay(qc, "o1");
    expect(ov?.opacity).toBe(33);
    expect(ov?.version).toBe(9);
    // The store override is NOT dropped by flush — it persists until the
    // data-gated reconciler in useMergedOverlayEdits sees the rendered
    // composition reflect the patch. Keeping it is what prevents the
    // fast/repeated-drag "previous location" flash.
    expect(committed(store, "o1")?.patch).toMatchObject({ opacity: 33 });
  });

  it("retains the override after flush so a stale refetch cannot flash the old value", async () => {
    const fetchMock = fetchReturning(200, { version: 4 });
    vi.stubGlobal("fetch", fetchMock);
    const { result, store, qc } = setup();

    act(() => {
      result.current.commit("o1", { opacity: 21 });
    });
    // Entry is committed + visible while in flight.
    expect(committed(store, "o1")?.patch).toEqual({ opacity: 21 });

    await act(async () => {
      result.current.flush("o1");
      await Promise.resolve();
      await Promise.resolve();
    });

    // flush optimistically updated the cache to the saved value...
    expect(cachedOverlay(qc, "o1")?.opacity).toBe(21);
    // ...but did NOT drop the override. So if a stale `refresh_query` refetch
    // from an earlier drag now overwrote the cache with an OLD value, the
    // override would still mask it (no flash). The drop is owned by the
    // data-gated reconciler in useMergedOverlayEdits (tested there).
    expect(committed(store, "o1")?.patch).toMatchObject({ opacity: 21 });
  });

  it("null patch value clears the key in the cache copy", async () => {
    const fetchMock = fetchReturning(200, { version: 2 });
    vi.stubGlobal("fetch", fetchMock);
    const { result, qc } = setup();

    // o2 starts with a background; a null clears it.
    const patch: OverlayTransformPatch = { background: null };
    act(() => {
      result.current.commit("o2", patch);
    });
    await act(async () => {
      result.current.flush("o2");
      await Promise.resolve();
      await Promise.resolve();
    });

    const ov = cachedOverlay(qc, "o2");
    expect("background" in (ov ?? {})).toBe(false);
    expect(ov?.version).toBe(2);
  });

  it("keeps the edit pending when a second commit lands during the in-flight PATCH", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result, store } = setup();

    act(() => {
      result.current.commit("o1", { opacity: 10 });
    });

    // Start the flush — fetch is now in flight (unresolved).
    act(() => {
      result.current.flush("o1");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // User edits again WHILE the PATCH is in flight → bumps the store version.
    act(() => {
      result.current.commit("o1", { opacity: 20 });
    });

    // Now resolve the in-flight PATCH with the OLD version.
    await act(async () => {
      resolveFetch(mkResponse(200, { version: 1 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // confirm(sentVersion=1) must NOT drop — the entry's version advanced.
    // The cumulative committed entry holds both edits.
    expect(committed(store, "o1")?.patch).toEqual({ opacity: 20 });
  });

  // ── Phase 5b AUTO-KEYFRAMING: debounced keyframe POST (Issue 1) ──────────
  /**
   * Render the hook wired with an auto-keyframe config for an ALREADY-animated
   * overlay ("ok1" carries a keyframe), so rect/opacity/transform3d edits route
   * to `addKeyframe` at the playhead. Returns the hook result + the addKeyframe spy.
   */
  function setupKeyframe(playheadTime = 3) {
    const store: OverlayEditStore = createOverlayEditStore();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(pieceKeys.composition("p1"), {
      manifest: { width: 1920, height: 1080, fps: 30, overlays: [] },
      audioClips: [],
    });
    const addKeyframe = vi.fn();
    const animatedOverlay = {
      id: "ok1",
      kind: "text",
      rect: { x: 0, y: 0, width: 100, height: 30 },
      startTime: 0,
      duration: 6,
      z: 0,
      // A single keyframe ⇒ overlayKeyframeTimes(overlay).length > 0.
      keyframes: {
        rect: { keyframes: [{ t: 0, value: { x: 0, y: 0, width: 100, height: 30 } }] },
      },
    } as unknown as import("@/lib/engine/types").Overlay;
    const autoKeyframe: AutoKeyframeConfig = {
      resolveOverlay: (id) => (id === "ok1" ? animatedOverlay : undefined),
      playheadTime: () => playheadTime,
      addKeyframe,
    };
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result, unmount } = renderHook(
      () => useOverlayTransformCommit("p1", store, autoKeyframe),
      { wrapper },
    );
    return { result, store, addKeyframe, unmount };
  }

  it("keyframe branch: debounces — no addKeyframe per tick, one merged POST at settle", async () => {
    const fetchMock = fetchReturning(200, { version: 1 });
    vi.stubGlobal("fetch", fetchMock);
    const { result, addKeyframe } = setupKeyframe(3);

    // Three per-tick edits during a drag (rect then rect then opacity).
    act(() => {
      result.current.commit("ok1", { rect: { x: 1, y: 1, width: 100, height: 30 } });
    });
    act(() => {
      vi.advanceTimersByTime(50);
      result.current.commit("ok1", { rect: { x: 9, y: 9, width: 100, height: 30 } });
    });
    act(() => {
      vi.advanceTimersByTime(50);
      result.current.commit("ok1", { opacity: 0.5 });
    });

    // No keyframe POST yet — still inside the (reset) debounce window.
    expect(addKeyframe).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });

    // Exactly ONE POST, merged: latest rect wins + opacity, at clip-relative time 3.
    expect(addKeyframe).toHaveBeenCalledTimes(1);
    expect(addKeyframe).toHaveBeenCalledWith("ok1", 3, {
      rect: { x: 9, y: 9, width: 100, height: 30 },
      opacity: 0.5,
    });
    // No flat PATCH — every field was routed to keyframes.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keyframe branch: flush fires the accumulated keyframe POST immediately", async () => {
    vi.stubGlobal("fetch", fetchReturning(200, { version: 1 }));
    const { result, addKeyframe } = setupKeyframe(4.5);

    act(() => {
      result.current.commit("ok1", { rect: { x: 2, y: 2, width: 100, height: 30 } });
    });
    expect(addKeyframe).not.toHaveBeenCalled();

    await act(async () => {
      result.current.flush("ok1");
      await Promise.resolve();
    });

    expect(addKeyframe).toHaveBeenCalledTimes(1);
    expect(addKeyframe).toHaveBeenCalledWith("ok1", 4.5, {
      rect: { x: 2, y: 2, width: 100, height: 30 },
    });
  });

  it("keyframe branch: unmount flushes a pending keyframe POST", () => {
    vi.stubGlobal("fetch", fetchReturning(200, { version: 1 }));
    const { result, addKeyframe, unmount } = setupKeyframe(2);

    act(() => {
      result.current.commit("ok1", { opacity: 0.3 });
    });
    expect(addKeyframe).not.toHaveBeenCalled();

    act(() => {
      unmount();
    });

    expect(addKeyframe).toHaveBeenCalledTimes(1);
    expect(addKeyframe).toHaveBeenCalledWith("ok1", 2, { opacity: 0.3 });
  });

  it("on failed PATCH: pending edit retained, cache untouched", async () => {
    const fetchMock = fetchReturning(500, { error: "boom" });
    vi.stubGlobal("fetch", fetchMock);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, store, qc } = setup();

    act(() => {
      result.current.commit("o1", { opacity: 77 });
    });
    await act(async () => {
      result.current.flush("o1");
      await Promise.resolve();
      await Promise.resolve();
    });

    // Edit retained for retry (committed entry not dropped).
    expect(committed(store, "o1")?.patch).toEqual({ opacity: 77 });
    // Cache NOT mutated.
    expect(cachedOverlay(qc, "o1")?.opacity).toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });
});
