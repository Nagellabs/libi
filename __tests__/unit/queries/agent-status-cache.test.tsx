// @vitest-environment jsdom
/**
 * How agent status reads keep each other current. The status bar reads every
 * agent and does not poll, while the setup wizard below it polls one agent: a
 * one-agent status that lands is written into the every-agent read rather than
 * invalidating it, so the bar never contradicts the wizard and a read of one
 * agent never re-resolves the other's CLI. A completed install invalidates the
 * status once per job, so a fresh install that completes after an older
 * completed one still refreshes it.
 *
 * Only a result React Query accepted is written onward: a fetch an
 * invalidation cancelled still resolves, and its stale answer must not reach
 * the every-agent read. Each one-agent read also carries when it STARTED,
 * because a read that began before an install finished can land after it, and
 * a read that began before the every-agent read was fetched never overwrites
 * it. Reads are carried onward by one cache subscription per client, held for
 * the client's lifetime by the app's QueryProvider, so a read that lands after
 * the wizard closed, or after the page was left, is still seen.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import type { AgentStatus } from "@/lib/agents/agent-status";
import { QueryProvider } from "@/components/providers/query-provider";
import {
  agentStatusKeys,
  forwardAgentStatusReads,
  useAgentInstall,
  useAgentStatus,
  useAllAgentStatus,
  useRecheckAgentCli,
} from "@/lib/queries/agent-status";
import { useWizardAgentStatus } from "@/hooks/agents/use-agent-status";

const fetchMock = vi.fn();

function res(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function agentStatus(agentId: "claude-code" | "codex", found: boolean): AgentStatus {
  return {
    agentId,
    cli: found ? { path: `/u/${agentId}`, realPath: `/u/${agentId}`, version: "9.9.9", meetsMinimum: true } : null,
    adapter: "ready",
    signIn: { confirmedAt: null, needsAuth: false },
    libiTools: { state: "not-connected" },
    ready: found,
  };
}

function wrap() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // What the app's QueryProvider does as it creates its client.
  forwardAgentStatusReads(qc);
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  return { qc, invalidate, Wrapper };
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe("useAgentStatus", () => {
  it("writes the fresh status into the cached every-agent read, keeping the other agent and fetching nothing more", async () => {
    const { qc, invalidate, Wrapper } = wrap();
    const claude = agentStatus("claude-code", true);
    const found = agentStatus("codex", true);
    qc.setQueryData(agentStatusKeys.all, { "claude-code": claude, codex: agentStatus("codex", false) });
    fetchMock.mockResolvedValue(res(200, { agents: { codex: found } }));

    const { result } = renderHook(() => useAgentStatus("codex"), { wrapper: Wrapper });

    await waitFor(() => expect(qc.getQueryData(agentStatusKeys.all)).toEqual({ "claude-code": claude, codex: found }));
    expect(result.current.data).toEqual(found);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/status?agent=codex");
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("leaves an every-agent read that was never fetched uncached", async () => {
    const { qc, Wrapper } = wrap();
    fetchMock.mockResolvedValue(res(200, { agents: { codex: agentStatus("codex", true) } }));

    const { result } = renderHook(() => useAgentStatus("codex"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryData(agentStatusKeys.all)).toBeUndefined();
  });

  it("a fetch cancelled before it landed writes nothing into the every-agent read", async () => {
    const { qc, Wrapper } = wrap();
    const before = { "claude-code": agentStatus("claude-code", true), codex: agentStatus("codex", false) };
    qc.setQueryData(agentStatusKeys.all, before);
    let land!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (land = resolve)));

    const { result } = renderHook(() => useAgentStatus("codex"), { wrapper: Wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // What an invalidation does to a read still in flight.
    await qc.cancelQueries({ queryKey: agentStatusKeys.one("codex") });
    land(res(200, { agents: { codex: agentStatus("codex", true) } }));
    await new Promise((r) => setTimeout(r, 20));

    expect(result.current.data).toBeUndefined();
    expect(qc.getQueryData(agentStatusKeys.all)).toEqual(before);
  });

  it("a one-agent read already cached when it mounts is not written over a newer every-agent read", () => {
    const { qc, Wrapper } = wrap();
    const newer = { "claude-code": agentStatus("claude-code", true), codex: agentStatus("codex", true) };
    qc.setQueryData(agentStatusKeys.one("codex"), { status: agentStatus("codex", false), readStartedAt: 1 });
    qc.setQueryData(agentStatusKeys.all, newer);

    renderHook(() => useAgentStatus("codex", { enabled: false }), { wrapper: Wrapper });

    expect(qc.getQueryData(agentStatusKeys.all)).toEqual(newer);
  });
});

describe("carrying one-agent reads into the every-agent read", () => {
  /** `?agent=codex` answers when the test says so; the every-agent read answers at once. */
  function routeFetches(all: () => unknown) {
    const pending: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation((url: string) =>
      url === "/api/agents/status"
        ? Promise.resolve(res(200, { agents: all() }))
        : new Promise<Response>((resolve) => pending.push(resolve)),
    );
    return { land: (body: unknown) => pending.shift()!(res(200, body)), pending };
  }

  it("a one-agent poll that lands after the wizard closed still reaches the status bar", async () => {
    const { qc, Wrapper } = wrap();
    const before = { "claude-code": agentStatus("claude-code", true), codex: agentStatus("codex", false) };
    const routes = routeFetches(() => before);
    const bar = renderHook(() => useAllAgentStatus(), { wrapper: Wrapper });
    await waitFor(() => expect(bar.result.current.data).toEqual(before));

    const wizard = renderHook(() => useAgentStatus("codex", { refetchInterval: 3000 }), { wrapper: Wrapper });
    await waitFor(() => expect(routes.pending).toHaveLength(1));
    wizard.unmount(); // Close, with the poll still in flight
    const found = agentStatus("codex", true);
    routes.land({ agents: { codex: found } });

    await waitFor(() => expect(bar.result.current.data).toEqual({ "claude-code": before["claude-code"], codex: found }));
    expect(qc.getQueryData(agentStatusKeys.all)).toEqual({ "claude-code": before["claude-code"], codex: found });
  });

  it("a one-agent read that started before the every-agent read was fetched is not written over it", async () => {
    const { qc, Wrapper } = wrap();
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const newer = { "claude-code": agentStatus("claude-code", true), codex: agentStatus("codex", true) };
      const routes = routeFetches(() => newer);
      const wizard = renderHook(() => useAgentStatus("codex"), { wrapper: Wrapper });
      await waitFor(() => expect(routes.pending).toHaveLength(1)); // started at 1_000

      now = 2_000;
      const bar = renderHook(() => useAllAgentStatus(), { wrapper: Wrapper });
      await waitFor(() => expect(bar.result.current.data).toEqual(newer)); // started at 2_000

      now = 3_000;
      routes.land({ agents: { codex: agentStatus("codex", false) } });
      await waitFor(() => expect(wizard.result.current.data).toEqual(agentStatus("codex", false)));
      expect(qc.getQueryData(agentStatusKeys.all)).toEqual(newer);

      // A read that starts after it is written as usual.
      now = 4_000;
      void wizard.result.current.refetch();
      await waitFor(() => expect(routes.pending).toHaveLength(1));
      routes.land({ agents: { codex: agentStatus("codex", false) } });
      await waitFor(() =>
        expect(qc.getQueryData(agentStatusKeys.all)).toEqual({ ...newer, codex: agentStatus("codex", false) }),
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("a one-agent read that lands after every status hook unmounted still reaches the every-agent read", async () => {
    const { qc, Wrapper } = wrap();
    const before = { "claude-code": agentStatus("claude-code", true), codex: agentStatus("codex", false) };
    const routes = routeFetches(() => before);
    const bar = renderHook(() => useAllAgentStatus(), { wrapper: Wrapper });
    await waitFor(() => expect(bar.result.current.data).toEqual(before));
    const wizard = renderHook(() => useAgentStatus("codex", { refetchInterval: 3000 }), { wrapper: Wrapper });
    await waitFor(() => expect(routes.pending).toHaveLength(1));

    wizard.unmount();
    bar.unmount(); // the page is left with the poll still in flight
    const found = agentStatus("codex", true);
    routes.land({ agents: { codex: found } });

    await waitFor(() => expect(qc.getQueryData(agentStatusKeys.all)).toEqual({ ...before, codex: found }));
  });

  it("an every-agent read that lands after the page was left still counts: an older one-agent read is not written over it when the page is opened again", async () => {
    const { qc, Wrapper } = wrap();
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const pending = new Map<string, Array<(r: Response) => void>>();
      fetchMock.mockImplementation(
        (url: string) =>
          new Promise<Response>((resolve) => pending.set(url, [...(pending.get(url) ?? []), resolve])),
      );
      const land = (url: string, body: unknown) => pending.get(url)!.shift()!(res(200, body));
      const oneUrl = "/api/agents/status?agent=codex";
      const allUrl = "/api/agents/status";

      const wizard = renderHook(() => useAgentStatus("codex"), { wrapper: Wrapper });
      await waitFor(() => expect(pending.get(oneUrl)).toHaveLength(1)); // started at 1_000
      now = 2_000;
      const bar = renderHook(() => useAllAgentStatus(), { wrapper: Wrapper });
      await waitFor(() => expect(pending.get(allUrl)).toHaveLength(1)); // started at 2_000
      wizard.unmount();
      bar.unmount(); // the page is left with both reads in flight

      const newer = { "claude-code": agentStatus("claude-code", true), codex: agentStatus("codex", true) };
      land(allUrl, { agents: newer });
      await waitFor(() => expect(qc.getQueryData(agentStatusKeys.all)).toEqual(newer));

      // The page is opened again; its read is still fresh, so it does not refetch.
      renderHook(() => useAllAgentStatus({ enabled: false }), { wrapper: Wrapper });
      now = 3_000;
      land(oneUrl, { agents: { codex: agentStatus("codex", false) } });
      await waitFor(() =>
        expect(qc.getQueryData(agentStatusKeys.one("codex"))).toEqual({ status: agentStatus("codex", false), readStartedAt: 1_000 }),
      );
      expect(qc.getQueryData(agentStatusKeys.all)).toEqual(newer);
    } finally {
      clock.mockRestore();
    }
  });

  it("subscribes once per client however often it is started, and keeps the subscription after every status hook unmounts", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const subscribe = vi.spyOn(qc.getQueryCache(), "subscribe");
    forwardAgentStatusReads(qc);
    forwardAgentStatusReads(qc);
    expect(subscribe).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => res(200, { agents: { codex: agentStatus("codex", true) } }));
    const Wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const hooks = renderHook(
      () => {
        useAllAgentStatus();
        useAgentStatus("codex");
        useRecheckAgentCli();
      },
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    hooks.unmount();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(qc.getQueryCache().hasListeners()).toBe(true);
  });

  it("the app's QueryProvider starts forwarding as it creates its client", () => {
    const Wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryProvider, null, children);
    const qc = renderHook(() => useQueryClient(), { wrapper: Wrapper }).result.current;
    const before = { "claude-code": agentStatus("claude-code", true), codex: agentStatus("codex", false) };
    act(() => {
      qc.setQueryData(agentStatusKeys.all, before);
      qc.setQueryData(agentStatusKeys.one("codex"), { status: agentStatus("codex", true), readStartedAt: Date.now() });
    });

    expect(qc.getQueryData(agentStatusKeys.all)).toEqual({ ...before, codex: agentStatus("codex", true) });
  });
});

describe("useWizardAgentStatus", () => {
  it("reports when a read STARTED, not when it landed, for polls and for Check again", async () => {
    const { Wrapper } = wrap();
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let land!: (r: Response) => void;
      fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (land = resolve)));
      const { result } = renderHook(() => useWizardAgentStatus("codex", { polling: false }), { wrapper: Wrapper });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      now = 5_000; // the read lands later — e.g. after an install completed meanwhile
      land(res(200, { agents: { codex: agentStatus("codex", false) } }));
      await waitFor(() => expect(result.current.status).toEqual(agentStatus("codex", false)));
      expect(result.current.readStartedAt).toBe(1_000);

      now = 7_000;
      fetchMock.mockImplementationOnce(async () => {
        now = 9_000;
        return res(200, { agents: { codex: agentStatus("codex", true) } });
      });
      let rechecked: unknown;
      await act(async () => {
        rechecked = await result.current.recheck();
      });
      expect(rechecked).toEqual(agentStatus("codex", true));
      await waitFor(() => expect(result.current.readStartedAt).toBe(7_000));
      expect(result.current.status).toEqual(agentStatus("codex", true));
    } finally {
      clock.mockRestore();
    }
  });
});

describe("useRecheckAgentCli", () => {
  it("writes the rechecked status into the agent's own read and the every-agent read, invalidating neither", async () => {
    const { qc, invalidate, Wrapper } = wrap();
    const claude = agentStatus("claude-code", true);
    const found = agentStatus("codex", true);
    qc.setQueryData(agentStatusKeys.all, { "claude-code": claude, codex: agentStatus("codex", false) });
    fetchMock.mockResolvedValue(res(200, { agents: { codex: found } }));

    const { result } = renderHook(() => useRecheckAgentCli(), { wrapper: Wrapper });
    await result.current.mutateAsync("codex");

    expect(fetchMock).toHaveBeenCalledWith("/api/agents/status?agent=codex&refresh=1");
    expect(qc.getQueryData(agentStatusKeys.one("codex"))).toEqual({ status: found, readStartedAt: expect.any(Number) });
    expect(qc.getQueryData(agentStatusKeys.all)).toEqual({ "claude-code": claude, codex: found });
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("useAgentInstall", () => {
  it("invalidates the agent status for every completed job, including one that completes after an older completed job", async () => {
    const { invalidate, Wrapper } = wrap();
    let job = { id: "job-1", status: "completed" };
    fetchMock.mockImplementation(async () => res(200, { job }));
    const statusInvalidations = () =>
      invalidate.mock.calls.filter(([filters]) => filters?.queryKey === agentStatusKeys.all).length;

    const { result } = renderHook(() => useAgentInstall("claude-code"), { wrapper: Wrapper });
    await waitFor(() => expect(statusInvalidations()).toBe(1));

    // A forced fresh install ran and completed too: same status, different job.
    job = { id: "job-2", status: "completed" };
    await result.current.refetch();
    await waitFor(() => expect(result.current.data?.job?.id).toBe("job-2"));
    await waitFor(() => expect(statusInvalidations()).toBe(2));

    // Reading that same job again is not a new completion.
    await result.current.refetch();
    expect(statusInvalidations()).toBe(2);
  });
});
