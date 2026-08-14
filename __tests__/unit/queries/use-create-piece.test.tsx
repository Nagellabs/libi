// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * A failing POST /api/pieces used to be swallowed whole: the mutation rejected,
 * the rejection sat unread in `mutation.error`, and the "Create your first
 * piece" button looked simply inert. Reported from dev Electron as "nothing
 * happens when I click it".
 */

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));

const { useCreatePiece } = await import("@/lib/queries/pieces");

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

describe("useCreatePiece", () => {
  it("tells the user when the server refuses, instead of failing silently", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "table pieces has no column named last_opened_at",
    } as unknown as Response);

    const { result } = renderHook(() => useCreatePiece(), { wrapper: wrap() });
    act(() => result.current.mutate());

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    const message = toastError.mock.calls[0][0] as string;
    expect(message).toMatch(/couldn't create a piece/i);
    // The server's own words survive — "Failed to create piece" alone gives
    // the user nothing to act on.
    expect(message).toContain("last_opened_at");
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("still reports a failure with an empty body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "",
    } as unknown as Response);

    const { result } = renderHook(() => useCreatePiece(), { wrapper: wrap() });
    act(() => result.current.mutate());

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0][0]).toMatch(/couldn't create a piece/i);
  });

  it("navigates and stays quiet on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "p1", name: "Today" }),
    } as unknown as Response);

    const { result } = renderHook(() => useCreatePiece(), { wrapper: wrap() });
    act(() => result.current.mutate());

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/editor"));
    expect(toastError).not.toHaveBeenCalled();
  });
});
