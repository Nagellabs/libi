// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useAddOverlay } from "@/lib/queries/overlays";
import { createSelectionStore } from "@/lib/preview/selection-store";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient();
  return createElement(QueryClientProvider, { client: qc }, children);
}

describe("useAddOverlay", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, overlayId: "ov-new" }), { status: 200 }),
    ) as never;
  });

  it("POSTs the payload and auto-selects the returned id", async () => {
    const sel = createSelectionStore(null);
    const { result } = renderHook(() => useAddOverlay("p1", sel), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ kind: "text", startTime: 0, duration: 3, z: 0, rect: { x: 0, y: 0, width: 1, height: 1 }, content: "x", font: "48px Inter", color: "#fff", align: "center" });
    });
    expect(global.fetch).toHaveBeenCalledWith("/api/pieces/p1/overlays", expect.objectContaining({ method: "POST" }));
    expect(sel.get()).toBe("ov-new");
  });
});
