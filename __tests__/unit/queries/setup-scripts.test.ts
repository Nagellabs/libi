// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SetupScriptsUnreachableError, useSetupScriptsDir } from "@/lib/queries/setup-scripts";

/**
 * `GET /api/agents/setup-scripts` has exactly one error shape it answers with
 * itself: a 500 with `{ error }` when the install is missing a script (see
 * `app/api/agents/setup-scripts/route.ts`). Anything else that keeps the hook
 * from returning a folder — a network error, a proxy's own 502/503, a body
 * that isn't that shape — is a different failure, and the Providers tab reads
 * `error instanceof SetupScriptsUnreachableError` to tell them apart.
 */

const fetchMock = vi.fn();

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(QueryClientProvider, { client: qc }, children);
  return Wrapper;
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe("useSetupScriptsDir", () => {
  it("returns the folder on a 200", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ dir: "/opt/libi/scripts" }) });
    const { result } = renderHook(() => useSetupScriptsDir(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe("/opt/libi/scripts");
  });

  it("the route's own not-found answer (500 with an error body) throws a plain Error, not SetupScriptsUnreachableError", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "libi's provider setup scripts are missing from this install." }),
    });
    const { result } = renderHook(() => useSetupScriptsDir(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).not.toBeInstanceOf(SetupScriptsUnreachableError);
    expect((result.current.error as Error).message).toBe("libi's provider setup scripts are missing from this install.");
  });

  it("a network error throws SetupScriptsUnreachableError", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useSetupScriptsDir(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(SetupScriptsUnreachableError);
  });

  it("a non-2xx with no error body (a proxy's own failure page) throws SetupScriptsUnreachableError", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => Promise.reject(new Error("not json")) });
    const { result } = renderHook(() => useSetupScriptsDir(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(SetupScriptsUnreachableError);
    expect((result.current.error as Error).message).toContain("503");
  });
});
