// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CATALOG_OWN_CHANGE_POLL_MS, templateKeys, useCatalogIndex } from "@/lib/queries/templates";

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;
const res = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(QueryClientProvider, { client: qc }, children);
  return { qc, Wrapper };
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("useCatalogIndex", () => {
  it("reads the catalog route under templateKeys.catalog", async () => {
    fetchMock.mockResolvedValue(res({ entries: [], fetchedAt: null, base: null, refreshed: false, error: "offline" }));
    const { qc, Wrapper } = wrap();
    const { result } = renderHook(() => useCatalogIndex(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/templates/cloud/catalog");
    expect(result.current.data).toMatchObject({ error: "offline", entries: [] });
    expect(qc.getQueryData(templateKeys.catalog)).toBe(result.current.data);
  });

  it("a refresh invalidates the templates queries without fetching the catalog twice", async () => {
    fetchMock.mockResolvedValue(res({ entries: [], fetchedAt: "2026-09-23T00:00:00.000Z", base: "b/", refreshed: true }));
    const { qc, Wrapper } = wrap();
    qc.setQueryData(templateKeys.list({ order: "trending", scope: "public" }), []);
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useCatalogIndex(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(qc.getQueryState(templateKeys.list({ order: "trending", scope: "public" }))?.isInvalidated).toBe(true));
    expect(spy).toHaveBeenCalledTimes(1);
    // The catalog query is invalidated mid-fetch; give any second fetch time to show.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a background refetch that brings a new index is not cancelled and re-sent by its own invalidation", async () => {
    fetchMock.mockResolvedValueOnce(res({ entries: [], fetchedAt: null, base: "b/", refreshed: false }));
    const { qc, Wrapper } = wrap();
    const list = templateKeys.list({ order: "trending", scope: "all" });
    qc.setQueryData(list, []);
    const { result } = renderHook(() => useCatalogIndex(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Now the catalog query HAS data: this is the 10-minute poll's path.
    fetchMock.mockResolvedValueOnce(res({ entries: [], fetchedAt: "2026-09-23T00:00:00.000Z", base: "b/", refreshed: true }));
    // What a re-sent GET would see: the cache it just refreshed.
    fetchMock.mockResolvedValue(res({ entries: [], fetchedAt: "2026-09-23T00:00:00.000Z", base: "b/", refreshed: false }));
    await result.current.refetch();
    await waitFor(() => expect(qc.getQueryState(list)?.isInvalidated).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(qc.getQueryData(templateKeys.catalog)).toMatchObject({ refreshed: true });
  });

  // A-F live check N1: the site's index is edge-cached for up to 5 minutes, so the tab asks every minute
  // while the route says one of the user's own changes isn't in the copy yet — every 10 otherwise.
  it("polls every minute while the answer carries the user's own pending changes, every 10 minutes otherwise", async () => {
    expect(CATALOG_OWN_CHANGE_POLL_MS).toBe(60_000);
    const pending = { entries: [], fetchedAt: null, base: "b/", refreshed: false, ownChanges: [{ cloudId: "a".repeat(20), version: 1, kind: "published", at: "x" }] };
    fetchMock.mockResolvedValue(res(pending));
    const { qc, Wrapper } = wrap();
    const { result } = renderHook(() => useCatalogIndex(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const q = qc.getQueryCache().find({ queryKey: templateKeys.catalog })!;
    // `refetchInterval` is an observer option, which the cache's own options type doesn't declare.
    const interval = (q.options as { refetchInterval?: unknown }).refetchInterval as (query: typeof q) => number;
    expect(interval(q)).toBe(60_000);
    qc.setQueryData(templateKeys.catalog, { ...pending, ownChanges: [] });
    expect(interval(q)).toBe(10 * 60 * 1000);
    qc.setQueryData(templateKeys.catalog, { entries: [], fetchedAt: null, base: "b/", refreshed: false });
    expect(interval(q)).toBe(10 * 60 * 1000);
  });
});
