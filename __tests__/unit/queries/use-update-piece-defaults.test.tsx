// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * A failing PUT /api/settings/piece-defaults used to be swallowed whole —
 * the mutation rejected, nothing told the user, and the button just looked
 * unselected. Same class of bug as useCreatePiece
 * (use-create-piece.test.tsx).
 */

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));

const { useUpdatePieceDefaults } = await import("@/lib/queries/piece-defaults");

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

function wrap() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  Wrapper.displayName = "QueryClientWrapper";
  return Wrapper;
}

describe("useUpdatePieceDefaults", () => {
  it("tells the user when the PUT fails, instead of failing silently", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as unknown as Response);

    const { result } = renderHook(() => useUpdatePieceDefaults(), { wrapper: wrap() });
    act(() => result.current.mutate({ aspectRatioId: "16:9" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0][0]).toMatch(/couldn't update the default aspect ratio/i);
  });

  it("stays quiet on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ aspectRatioId: "16:9" }),
    } as unknown as Response);

    const { result } = renderHook(() => useUpdatePieceDefaults(), { wrapper: wrap() });
    act(() => result.current.mutate({ aspectRatioId: "16:9" }));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toastError).not.toHaveBeenCalled();
  });
});
