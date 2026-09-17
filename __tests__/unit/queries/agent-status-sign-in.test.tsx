// @vitest-environment jsdom
/**
 * `useConfirmAgentSignIn` stores the user's word that an agent's CLI is signed
 * in: it POSTs /api/agents/<id>/sign-in-confirmation and then invalidates every
 * agent status — including the one-agent query the setup wizard polls — because
 * the confirmation also clears an older observed sign-in rejection. A refused
 * POST rejects and leaves the status alone.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { agentStatusKeys, useConfirmAgentSignIn } from "@/lib/queries/agent-status";

const fetchMock = vi.fn();

function res(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function wrap() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // A cached status for the agent, as the wizard's polled query would leave it.
  qc.setQueryData(agentStatusKeys.one("claude-code"), { agentId: "claude-code" });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  return { qc, invalidate, Wrapper };
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe("useConfirmAgentSignIn", () => {
  it("POSTs the agent's sign-in confirmation, then invalidates every agent status", async () => {
    fetchMock.mockResolvedValue(res(200, { confirmedAt: "2026-09-11T00:00:00.000Z" }));
    const { qc, invalidate, Wrapper } = wrap();
    const { result } = renderHook(() => useConfirmAgentSignIn(), { wrapper: Wrapper });
    await expect(result.current.mutateAsync("claude-code")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/claude-code/sign-in-confirmation", { method: "POST" });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: agentStatusKeys.all }));
    expect(qc.getQueryState(agentStatusKeys.one("claude-code"))?.isInvalidated).toBe(true);
  });

  it("confirms the agent it was given — Codex POSTs Codex's route", async () => {
    fetchMock.mockResolvedValue(res(200, { confirmedAt: "2026-09-11T00:00:00.000Z" }));
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useConfirmAgentSignIn(), { wrapper: Wrapper });
    await result.current.mutateAsync("codex");
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/codex/sign-in-confirmation", { method: "POST" });
  });

  it("rejects when the server refuses, and invalidates nothing", async () => {
    fetchMock.mockResolvedValue(res(500, {}));
    const { qc, invalidate, Wrapper } = wrap();
    const { result } = renderHook(() => useConfirmAgentSignIn(), { wrapper: Wrapper });
    await expect(result.current.mutateAsync("claude-code")).rejects.toThrow("sign-in confirmation failed (500)");
    expect(invalidate).not.toHaveBeenCalled();
    expect(qc.getQueryState(agentStatusKeys.one("claude-code"))?.isInvalidated).toBe(false);
  });
});
