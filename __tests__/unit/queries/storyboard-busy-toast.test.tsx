// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * QA 2026-09-18 U1: a Board drag (layout PATCH) or card edit that hit a held
 * storyboard lock got a 409 after 60 s and failed silently — only a console
 * error, with the node left at its unsaved position. The user is now told the
 * change wasn't saved, and the board re-reads the saved state.
 */

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));

const { useUpdateLayout, useUpdateCard, storyboardKeys } = await import("@/lib/queries/storyboard");

const fetchMock = vi.fn();
const BUSY = { error: "Storyboard is busy — another edit is still running.", retryable: true, partial: false };

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

function wrap() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  Wrapper.displayName = "QueryClientWrapper";
  return { Wrapper, invalidate };
}

describe("storyboard mutations surface a failed save", () => {
  it("a busy layout PATCH toasts that the change wasn't saved and re-reads the board", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => BUSY } as unknown as Response);
    const { Wrapper, invalidate } = wrap();
    const { result } = renderHook(() => useUpdateLayout("p1"), { wrapper: Wrapper });
    act(() => result.current.mutate({ positions: { a: { x: 1, y: 2 } } }));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0][0]).toMatch(/not saved/i);
    expect(toastError.mock.calls[0][1]).toMatchObject({ description: BUSY.error });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: storyboardKeys.detail("p1") });
  });

  it("a failed card PATCH toasts too", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => BUSY } as unknown as Response);
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useUpdateCard("p1"), { wrapper: Wrapper });
    act(() => result.current.mutate({ cardId: "c1", patch: { description: "x" } }));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0][1]).toMatchObject({ description: BUSY.error });
  });

  it("stays quiet on success", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as unknown as Response);
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useUpdateLayout("p1"), { wrapper: Wrapper });
    act(() => result.current.mutate({ positions: {} }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toastError).not.toHaveBeenCalled();
  });
});
