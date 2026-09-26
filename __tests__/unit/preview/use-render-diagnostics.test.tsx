// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRenderDiagnostics } from "@/lib/preview/render-diagnostics";
import { FRAME_STARTING_MESSAGE } from "@/lib/sandbox/host";

const fetchSpy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status: 204 }));
beforeEach(() => {
  vi.useFakeTimers();
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const urls = () => fetchSpy.mock.calls.map((c) => String(c[0]));

describe("useRenderDiagnostics (the preview's per-piece store)", () => {
  it("no piece open (`pieceId` is \"\"): no store, no PUT to /api/pieces//… (Task 11 fix M2)", async () => {
    const { result } = renderHook(() => useRenderDiagnostics(""));
    result.current.onDiagnostic?.({ overlayId: "a", kind: "code", phase: "render", message: "x" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("files a report under the piece open NOW, and names that piece as the diagnostics key", async () => {
    const { result, rerender } = renderHook(({ id }) => useRenderDiagnostics(id), { initialProps: { id: "p1" } });
    expect(result.current.diagnosticsKey).toBe("p1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(urls()).toEqual(["/api/pieces/p1/render-diagnostics"]); // the first sync
    rerender({ id: "p2" });
    expect(result.current.diagnosticsKey).toBe("p2");
    result.current.onDiagnostic?.({ overlayId: "a", kind: "code", phase: "render", message: "x" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(urls().slice(1)).toEqual(["/api/pieces/p2/render-diagnostics"]);
    const body = JSON.parse(String((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body));
    expect(body.diagnostics.map((d: { overlayId: string }) => d.overlayId)).toEqual(["a"]);
  });
  /** Sandbox re-review 3, R3-M4: the store is disposed before the sandbox
   *  withdraws its notice (unmount), or the withdrawal reaches the NEXT piece's
   *  store (piece switch) — either way the server kept "still starting" for
   *  the 5 min TTL. The retiring store withdraws it itself. */
  describe("the sandbox's \"still starting\" notice does not outlive the preview (R3-M4)", () => {
    const lastBodyFor = (pieceId: string) => {
      const call = fetchSpy.mock.calls.filter((c) => String(c[0]) === `/api/pieces/${pieceId}/render-diagnostics`).at(-1);
      return JSON.parse(String((call![1] as RequestInit).body)) as { unattributed: Array<{ message: string }> };
    };

    it("is withdrawn from the server on unmount, though the sandbox's own withdrawal never reaches the store", async () => {
      const { result, unmount } = renderHook(() => useRenderDiagnostics("p1"));
      result.current.onUnattributed?.({ message: FRAME_STARTING_MESSAGE });
      result.current.onUnattributed?.({ message: "an unrelated runtime report" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(lastBodyFor("p1").unattributed.map((u) => u.message)).toContain(FRAME_STARTING_MESSAGE);
      const opts = result.current;
      unmount();
      // What React's order does: the sandbox is destroyed after the store is gone.
      opts.onUnattributedCleared?.(FRAME_STARTING_MESSAGE);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(lastBodyFor("p1").unattributed.map((u) => u.message)).toEqual(["an unrelated runtime report"]);
    });

    it("is withdrawn from the OLD piece on a piece switch, while the withdrawal itself reaches only the new one", async () => {
      const { result, rerender } = renderHook(({ id }) => useRenderDiagnostics(id), { initialProps: { id: "p1" } });
      result.current.onUnattributed?.({ message: FRAME_STARTING_MESSAGE });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(lastBodyFor("p1").unattributed.map((u) => u.message)).toEqual([FRAME_STARTING_MESSAGE]);
      rerender({ id: "p2" });
      result.current.onUnattributedCleared?.(FRAME_STARTING_MESSAGE);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(lastBodyFor("p1").unattributed).toEqual([]);
    });

    it("sends nothing extra when no notice was up", async () => {
      const { unmount } = renderHook(() => useRenderDiagnostics("p1"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      const before = fetchSpy.mock.calls.length;
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(fetchSpy.mock.calls.length).toBe(before);
    });
  });
});
