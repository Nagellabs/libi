// @vitest-environment jsdom
/**
 * Retry on the Providers tab and on the Global setup card. A plain refetch can
 * be answered from the server's 5 s memo of a codex listing that just failed,
 * so each Retry reads with `?refresh=1` (the server then asks codex again,
 * joining a listing already running) and writes the answer into the cache the
 * tab renders from.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { providerKeys, useProviders, useRefreshProviders } from "@/lib/queries/providers";
import { libiRegistrationKeys, useLibiRegistration, useRefreshLibiRegistration } from "@/lib/queries/libi-registration";

const fetchMock = vi.fn();

function res(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

/** A promise this test settles by hand, to hold one fetch open while another completes around it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(QueryClientProvider, { client: qc }, children);
  return { qc, Wrapper };
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe("Retry reads with ?refresh=1", () => {
  it("the Providers tab's Retry asks /api/providers for a fresh read and puts the answer where useProviders reads it", async () => {
    const body = { connected: [], codex: "stale" };
    fetchMock.mockResolvedValue(res(200, body));
    const { qc, Wrapper } = wrap();
    qc.setQueryData(providerKeys.all, { connected: [], codex: "unread" });
    const { result } = renderHook(() => useRefreshProviders(), { wrapper: Wrapper });
    await result.current.mutateAsync();
    expect(fetchMock).toHaveBeenCalledWith("/api/providers?refresh=1");
    expect(qc.getQueryData(providerKeys.all)).toEqual(body);
    // The legacy-key notices share the prefix, never the answer.
    expect(qc.getQueryData(providerKeys.legacy)).toBeUndefined();
  });

  it("the Global setup card's Retry asks /api/agents/libi-registration for a fresh read and puts the agents where useLibiRegistration reads them", async () => {
    const agents = { "claude-code": { state: "not-connected" }, codex: { state: "connected", stale: true } };
    fetchMock.mockResolvedValue(res(200, { agents }));
    const { qc, Wrapper } = wrap();
    qc.setQueryData(libiRegistrationKeys.all, { "claude-code": { state: "not-connected" }, codex: { state: "unknown" } });
    const { result } = renderHook(() => useRefreshLibiRegistration(), { wrapper: Wrapper });
    await result.current.mutateAsync();
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/libi-registration?refresh=1");
    expect(qc.getQueryData(libiRegistrationKeys.all)).toEqual(agents);
  });

  it("a Retry that fails leaves the answer on screen as it was", async () => {
    fetchMock.mockResolvedValue(res(500, {}));
    const { qc, Wrapper } = wrap();
    const before = { "claude-code": { state: "not-connected" }, codex: { state: "unknown" } };
    qc.setQueryData(libiRegistrationKeys.all, before);
    const { result } = renderHook(() => useRefreshLibiRegistration(), { wrapper: Wrapper });
    await expect(result.current.mutateAsync()).rejects.toThrow();
    expect(qc.getQueryData(libiRegistrationKeys.all)).toEqual(before);
  });
});

/**
 * Both Retry mutations justify `cancelQueries` with "a poll that started before the Retry must not
 * land over its answer" — but that only means something with a poll actually in flight when the
 * Retry's own answer is written. These hold a poll's fetch open with `deferred`, let the Retry land
 * first, and only then let the poll's (now stale) response resolve.
 */
describe("Retry cancels an in-flight read before it can land over the fresh answer", () => {
  it("useRefreshLibiRegistration: a pending useLibiRegistration read that resolves late never overwrites the Retry's answer", async () => {
    const pending = deferred<Response>();
    const staleFromThePoll = { "claude-code": { state: "not-connected" }, codex: { state: "unknown" } };
    const freshFromRetry = { "claude-code": { state: "not-connected" }, codex: { state: "connected", stale: true } };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/agents/libi-registration") return pending.promise;
      if (url === "/api/agents/libi-registration?refresh=1") return res(200, { agents: freshFromRetry });
      throw new Error(`unexpected fetch ${url}`);
    });
    const { qc, Wrapper } = wrap();
    const { result } = renderHook(() => ({ read: useLibiRegistration(), retry: useRefreshLibiRegistration() }), {
      wrapper: Wrapper,
    });
    // The plain read's fetch is in flight, held open by `pending`.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/agents/libi-registration"));
    expect(qc.getQueryData(libiRegistrationKeys.all)).toBeUndefined();
    // Retry lands while it is still pending.
    await result.current.retry.mutateAsync();
    expect(qc.getQueryData(libiRegistrationKeys.all)).toEqual(freshFromRetry);
    // The original read finally resolves, late, with a now-stale answer.
    pending.resolve(res(200, { agents: staleFromThePoll }));
    await new Promise((r) => setTimeout(r, 0));
    expect(qc.getQueryData(libiRegistrationKeys.all)).toEqual(freshFromRetry);
  });

  it("useRefreshProviders: a pending useProviders read that resolves late never overwrites the Retry's answer", async () => {
    const pending = deferred<Response>();
    const staleFromThePoll = { connected: [], codex: "unread" as const };
    const freshFromRetry = { connected: [], codex: "stale" as const };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/providers") return pending.promise;
      if (url === "/api/providers?refresh=1") return res(200, freshFromRetry);
      throw new Error(`unexpected fetch ${url}`);
    });
    const { qc, Wrapper } = wrap();
    const { result } = renderHook(() => ({ read: useProviders(), retry: useRefreshProviders() }), { wrapper: Wrapper });
    // The plain read's fetch is in flight, held open by `pending`.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/providers"));
    expect(qc.getQueryData(providerKeys.all)).toBeUndefined();
    // Retry lands while it is still pending.
    await result.current.retry.mutateAsync();
    expect(qc.getQueryData(providerKeys.all)).toEqual(freshFromRetry);
    // The original read finally resolves, late, with a now-stale answer.
    pending.resolve(res(200, staleFromThePoll));
    await new Promise((r) => setTimeout(r, 0));
    expect(qc.getQueryData(providerKeys.all)).toEqual(freshFromRetry);
  });
});
