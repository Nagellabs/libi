// @vitest-environment jsdom
/**
 * `useRestartMcpEndpoint` POSTs /api/mcp/restart, resolves with the port the
 * endpoint came back on, surfaces the server's error text on a 503, and
 * invalidates the health query EITHER way — a failed restart changes what the
 * health card should show just as much as a successful one does.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRestartMcpEndpoint } from "@/lib/queries/mcp-restart";
import { mcpHealthKeys } from "@/lib/queries/mcp-health";

const fetchMock = vi.fn();

function res(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function wrap() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  return { invalidate, Wrapper };
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe("useRestartMcpEndpoint", () => {
  it("POSTs the restart route and resolves with the port, then invalidates mcp health", async () => {
    fetchMock.mockResolvedValue(res(200, { ok: true, port: 3457 }));
    const { invalidate, Wrapper } = wrap();
    const { result } = renderHook(() => useRestartMcpEndpoint(), { wrapper: Wrapper });
    await expect(result.current.mutateAsync()).resolves.toEqual({ port: 3457 });
    expect(fetchMock).toHaveBeenCalledWith("/api/mcp/restart", { method: "POST" });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: mcpHealthKeys.all }),
    );
  });

  it("rejects with the server's error text on a 503, and still invalidates mcp health", async () => {
    fetchMock.mockResolvedValue(res(503, { error: "MCP aggregator is already restarting" }));
    const { invalidate, Wrapper } = wrap();
    const { result } = renderHook(() => useRestartMcpEndpoint(), { wrapper: Wrapper });
    await expect(result.current.mutateAsync()).rejects.toThrow("MCP aggregator is already restarting");
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: mcpHealthKeys.all }),
    );
  });
});
