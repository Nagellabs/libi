// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import {
  useApplyLayerEffect,
  useClearLayerEffect,
} from "@/lib/queries/effects";
import { pieceKeys } from "@/lib/queries/pieces";

vi.mock("@/lib/analytics/client", () => ({ trackEvent: vi.fn() }));

function mkResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface CachedComposition {
  manifest: {
    overlays?: { id: string; effects?: unknown }[];
    scenes?: { id: string; effects?: unknown }[];
    audioClips?: { id: string; effects?: unknown }[];
  } & Record<string, unknown>;
  scenes: unknown;
  audioClips: unknown;
}

/** Seed the composition cache with one overlay carrying an existing `out`
 *  effect, so we can assert merge (apply adds `in`, keeps `out`) and clear. */
function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData<CachedComposition>(pieceKeys.composition("p1"), {
    manifest: {
      sceneOrder: [],
      width: 1920,
      height: 1080,
      fps: 30,
      overlays: [
        { id: "o1", effects: { out: { effectId: "fade" } } },
      ],
      scenes: [],
      audioClips: [],
    },
    scenes: [],
    audioClips: [],
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  return { qc, wrapper };
}

function getOverlay(qc: QueryClient, id: string) {
  const data = qc.getQueryData<CachedComposition>(pieceKeys.composition("p1"));
  return data?.manifest.overlays?.find((o) => o.id === id);
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("useApplyLayerEffect — optimistic cache", () => {
  it("onMutate patches the cached overlay effects IMMEDIATELY (before fetch resolves), merging with existing phases", async () => {
    const { qc, wrapper } = setup();
    // A fetch that never resolves during the synchronous assertion window.
    let resolveFetch: (r: Response) => void = () => {};
    const fetchMock = vi.fn(
      () => new Promise<Response>((res) => { resolveFetch = res; }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useApplyLayerEffect("p1"), { wrapper });

    act(() => {
      result.current.mutate({
        layerId: "o1",
        phase: "in",
        effectId: "slide",
        durationMs: 500,
        params: { distance: 120 },
      });
    });

    // The cache reflects the optimistic merge before the network resolves.
    await waitFor(() => {
      expect(getOverlay(qc, "o1")?.effects).toEqual({
        out: { effectId: "fade" },
        in: { effectId: "slide", durationMs: 500, params: { distance: 120 } },
      });
    });

    // Let the in-flight mutation settle so React Query doesn't warn.
    act(() => resolveFetch(mkResponse(200, { success: true, layerKind: "overlay-text" })));
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });

  it("onError rolls the cache back to the prior effects on a failed apply", async () => {
    const { qc, wrapper } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => mkResponse(400, { error: "unknown_effect" })));

    const { result } = renderHook(() => useApplyLayerEffect("p1"), { wrapper });

    act(() => {
      result.current.mutate({ layerId: "o1", phase: "in", effectId: "bogus" });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // Rolled back to the original single `out` effect — no leftover `in`.
    expect(getOverlay(qc, "o1")?.effects).toEqual({ out: { effectId: "fade" } });
  });
});

describe("useClearLayerEffect — optimistic cache", () => {
  it("onMutate removes the phase immediately; clearing the last phase drops the effects block", async () => {
    const { qc, wrapper } = setup();
    let resolveFetch: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((res) => { resolveFetch = res; })),
    );

    const { result } = renderHook(() => useClearLayerEffect("p1"), { wrapper });

    act(() => {
      result.current.mutate({ layerId: "o1", phase: "out" });
    });

    // `out` was the only phase → the whole effects block is removed.
    await waitFor(() => {
      expect(getOverlay(qc, "o1")?.effects).toBeUndefined();
    });

    act(() => resolveFetch(mkResponse(200, { success: true })));
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });

  it("onError restores the effects block on a failed clear", async () => {
    const { qc, wrapper } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => mkResponse(400, { error: "boom" })));

    const { result } = renderHook(() => useClearLayerEffect("p1"), { wrapper });

    act(() => {
      result.current.mutate({ layerId: "o1", phase: "out" });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(getOverlay(qc, "o1")?.effects).toEqual({ out: { effectId: "fade" } });
  });
});
