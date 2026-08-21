// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useOverlayEditing } from "@/hooks/editor/use-overlay-editing";
import type { Composition, TextOverlay } from "@/lib/engine/types";

const mkText = (id: string, content = "hi"): TextOverlay => ({
  id, kind: "text", content,
  font: "24px Inter", color: "#fff", align: "left", opacity: 1,
  rect: { x: 0, y: 0, width: 100, height: 30 },
  startTime: 0, duration: 1, z: 0,
});

function mkComp(overlays: TextOverlay[]): Composition {
  return {
    id: "c", name: "", width: 100, height: 100, fps: 30, 
    overlays,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient();
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useOverlayEditing", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
  });

  it("startEdit sets editingOverlay to the matching text overlay", async () => {
    const comp = mkComp([mkText("t1")]);
    const { result } = renderHook(() => useOverlayEditing("p1", comp), { wrapper });
    expect(result.current.editingOverlay).toBeNull();
    act(() => { result.current.startEdit("t1"); });
    await waitFor(() => expect(result.current.editingOverlay?.id).toBe("t1"));
  });

  it("commit fires PATCH with the new content and clears editing state", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const comp = mkComp([mkText("t1", "before")]);
    const { result } = renderHook(() => useOverlayEditing("p1", comp), { wrapper });
    act(() => { result.current.startEdit("t1"); });
    await waitFor(() => expect(result.current.editingOverlay?.id).toBe("t1"));
    await act(async () => { await result.current.commit("after"); });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/pieces/p1/overlays/t1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ content: "after" }),
      }),
    );
    expect(result.current.editingOverlay).toBeNull();
  });

  it("cancel clears editing state without firing a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const comp = mkComp([mkText("t1")]);
    const { result } = renderHook(() => useOverlayEditing("p1", comp), { wrapper });
    act(() => { result.current.startEdit("t1"); });
    await waitFor(() => expect(result.current.editingOverlay?.id).toBe("t1"));
    act(() => { result.current.cancel(); });
    expect(result.current.editingOverlay).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("editingOverlay is null when the id no longer exists in the composition", async () => {
    const comp = mkComp([]);
    const { result } = renderHook(() => useOverlayEditing("p1", comp), { wrapper });
    act(() => { result.current.startEdit("t1"); });
    // No matching overlay — stays null.
    expect(result.current.editingOverlay).toBeNull();
  });

  it("commit with null activePieceId is a no-op (no PATCH)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const comp = mkComp([mkText("t1")]);
    const { result } = renderHook(() => useOverlayEditing(null, comp), { wrapper });
    act(() => { result.current.startEdit("t1"); });
    await act(async () => { await result.current.commit("after"); });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("commit when nothing is being edited is a no-op (no PATCH)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const comp = mkComp([mkText("t1")]);
    const { result } = renderHook(() => useOverlayEditing("p1", comp), { wrapper });
    // Do NOT call startEdit.
    await act(async () => { await result.current.commit("after"); });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("commit skips invalidate when PATCH returns !res.ok", async () => {
    const fetchMock = vi.fn(async () => new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    // Suppress the expected console.error so test output stays clean.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const comp = mkComp([mkText("t1", "before")]);

    // Spy on invalidateQueries by injecting a wrapper QueryClient.
    const invalidateSpy = vi.fn();
    const qc = new QueryClient();
    const origInvalidate = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = (...args: Parameters<typeof origInvalidate>) => {
      invalidateSpy(...args);
      return origInvalidate(...args);
    };
    const customWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => useOverlayEditing("p1", comp),
      { wrapper: customWrapper },
    );
    act(() => { result.current.startEdit("t1"); });
    await act(async () => { await result.current.commit("after"); });

    expect(fetchMock).toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("commit skips invalidate when PATCH throws (network error)", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    vi.stubGlobal("fetch", fetchMock);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const comp = mkComp([mkText("t1")]);

    const invalidateSpy = vi.fn();
    const qc = new QueryClient();
    const origInvalidate = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = (...args: Parameters<typeof origInvalidate>) => {
      invalidateSpy(...args);
      return origInvalidate(...args);
    };
    const customWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => useOverlayEditing("p1", comp),
      { wrapper: customWrapper },
    );
    act(() => { result.current.startEdit("t1"); });
    await act(async () => { await result.current.commit("after"); });

    expect(fetchMock).toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
