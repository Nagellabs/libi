// @vitest-environment jsdom
/**
 * The Templates page's only data path. Three things here regress silently:
 *   - the URL a hook builds (the page's filters are query params, not state);
 *   - a `q` under 2 characters is NOT sent — the server lists, so a user who
 *     has typed one letter sees the library rather than an FTS shot in the dark;
 *   - a mutation invalidates the templates prefix and NOT the world.
 * No hook here opens an EventSource: the live refresh rides libi's one SSE
 * connection via `refresh_query { queryKey: "templates" }`.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  templateKeys,
  useTemplates,
  useTemplateSearch,
  useTemplate,
  useDeleteTemplate,
  templateMediaUrl,
} from "@/lib/queries/templates";

const fetchMock = vi.fn();
let client: QueryClient;
function wrap() {
  client = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "TemplateQueryWrapper";
  return Wrapper;
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe("template hooks", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("useTemplates hits GET /api/templates with order and scope", async () => {
    fetchMock.mockResolvedValue(ok({ templates: [{ id: "t1" }] }));
    const { result } = renderHook(() => useTemplates({ order: "newest", scope: "local" }), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data).toEqual([{ id: "t1" }]));
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/templates?order=newest&scope=local");
  });

  it("useTemplateSearch keeps the previous result while the next filter loads", async () => {
    // Each keystroke is a new key with an empty cache; without this the grid
    // would flash a skeleton between every character.
    fetchMock.mockResolvedValue(ok({ templates: [{ id: "t1" }, { id: "t2" }] }));
    const { result, rerender } = renderHook(({ q }: { q: string }) => useTemplateSearch({ q }), {
      wrapper: wrap(),
      initialProps: { q: "" },
    });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    let resolveNext: (r: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((r) => { resolveNext = r; }));
    rerender({ q: "lower" });
    // Mid-flight: the old rows are still there, flagged as stand-ins.
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.data).toHaveLength(2);
    expect(result.current.isPending).toBe(false);
    await act(async () => {
      resolveNext(ok({ templates: [{ id: "t1" }] }));
    });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
    expect(result.current.data).toHaveLength(1);
  });

  it("useTemplateSearch sends q and tags; a 1-char q is sent without q (server lists)", async () => {
    fetchMock.mockResolvedValue(ok({ templates: [] }));
    const { result } = renderHook(
      () => useTemplateSearch({ q: "lower", tags: ["promo", "ugc"], order: "trending" }),
      { wrapper: wrap() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/templates?order=trending&q=lower&tags=promo%2Cugc");
    const { result: r2 } = renderHook(() => useTemplateSearch({ q: "l" }), { wrapper: wrap() });
    await waitFor(() => expect(r2.current.isSuccess).toBe(true));
    expect(String(fetchMock.mock.calls[1][0])).toBe("/api/templates?order=trending");
  });

  it("useTemplate fetches the detail and stays idle without an id", async () => {
    fetchMock.mockResolvedValue(ok({ template: { id: "t1" }, scaffold: null, instructions: "" }));
    const { result } = renderHook(() => useTemplate("t1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data?.template.id).toBe("t1"));
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/templates/t1");
    const { result: off } = renderHook(() => useTemplate(null), { wrapper: wrap() });
    expect(off.current.fetchStatus).toBe("idle");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("useDeleteTemplate DELETEs and invalidates the templates prefix only — all but the deleted template's own page query", async () => {
    fetchMock.mockResolvedValue(ok({ ok: true }));
    const { result } = renderHook(() => useDeleteTemplate(), { wrapper: wrap() });
    const spy = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      await result.current.mutateAsync("t1");
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/templates/t1", expect.objectContaining({ method: "DELETE" }));
    expect(spy).toHaveBeenCalledTimes(1);
    const [filters] = spy.mock.calls[0] as [{ queryKey: readonly unknown[]; predicate: (q: { queryKey: readonly unknown[] }) => boolean }];
    expect(filters.queryKey).toEqual(templateKeys.all);
    // Re-read, the deleted template's page answered 404 and flashed "not on this machine" (D5–D6 review M8).
    expect(filters.predicate({ queryKey: templateKeys.detail("t1") })).toBe(false);
    expect(filters.predicate({ queryKey: templateKeys.detail("t2") })).toBe(true);
    expect(filters.predicate({ queryKey: templateKeys.list({ order: "trending" } as never) })).toBe(true);
  });

  it("templateMediaUrl encodes the name", () => {
    expect(templateMediaUrl("t1", "poster.jpg")).toBe("/api/templates/t1/media/poster.jpg");
    expect(templateMediaUrl("t1", "my logo.png")).toBe("/api/templates/t1/media/my%20logo.png");
  });
});
