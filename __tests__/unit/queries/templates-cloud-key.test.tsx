// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
import { toast } from "sonner";
import { CloudRouteError, revealCreatorKey, useCreatorKeyStatus, useImportCreatorKey, useInstallTemplate, useSetTemplateHidden } from "@/lib/queries/templates-cloud";
import { VISIBILITY_OUTCOME_UNKNOWN_MESSAGE } from "@/lib/templates/cloud/constants";

const KEY = "Ab3_-".repeat(8) + "xyz";
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/templates/cloud/key" && !init?.method) return Response.json({ hasKey: true, masked: "Ab3_…-xyz", authorId: "a", nickname: null });
    if (url === "/api/templates/cloud/key/reveal" && init?.method === "POST") return Response.json({ key: KEY });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("creator key client", () => {
  it("the status query reads only the masked status — no reveal request, and no key in the cache", async () => {
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useCreatorKeyStatus(), { wrapper });
    await waitFor(() => expect(result.current.data?.masked).toBe("Ab3_…-xyz"));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/templates/cloud/key"]);
    expect(JSON.stringify(qc.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(KEY);
  });

  it("revealCreatorKey POSTs to the guarded reveal route and hands back the key", async () => {
    expect(await revealCreatorKey()).toBe(KEY);
    expect(fetchMock).toHaveBeenCalledWith("/api/templates/cloud/key/reveal", expect.objectContaining({ method: "POST" }));
  });

  it("revealCreatorKey throws the route's refusal", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "This install has no creator key yet." }, { status: 404 }));
    await expect(revealCreatorKey()).rejects.toThrow("This install has no creator key yet.");
  });
  it("an import sends `replace` in the PUT body, and the server asking to confirm a replacement is the card's to show — no toast", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "This install already has a different creator key.", code: "replace_required" }, { status: 409 }));
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useImportCreatorKey(), { wrapper });
    const onError = vi.fn();
    result.current.mutate({ key: KEY, replace: false }, { onError });
    await waitFor(() => expect(onError).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/templates/cloud/key");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ key: KEY, replace: false });
    expect(onError.mock.calls[0][0]).toBeInstanceOf(CloudRouteError);
    expect(onError.mock.calls[0][0].code).toBe("replace_required");
    expect(toast.error).not.toHaveBeenCalled();
    // Any other refusal is still toasted.
    fetchMock.mockResolvedValueOnce(Response.json({ error: "nope" }, { status: 400 }));
    result.current.mutate({ key: KEY, replace: true });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nope"));
  });
});

// A11 fix round 1: the install toast is libi's copy — the route's, or a fixed line — never raw text.
describe("install toast", () => {
  const ID = "abcdefghijklmnopqrst";
  it("shows the route's copy for a refusal, and a fixed line when libi's server didn't answer", async () => {
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useInstallTemplate(), { wrapper });
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: "This template is no longer in the catalog.", code: "not_found" }, { status: 400 }));
    result.current.mutate({ cloudId: ID, version: 1 });
    await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith("This template is no longer in the catalog."));
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed: RAW NETWORK TEXT"));
    result.current.mutate({ cloudId: ID, version: 1 });
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
    expect(vi.mocked(toast.error).mock.calls[1][0]).toBe("Couldn't install the template — libi's server didn't answer.");
  });
});

// Final review m2: a visibility change libi can't confirm either way is a warning that claims
// neither outcome — never the error toast that says the change was refused.
describe("visibility toast", () => {
  const ID = "abcdefghijklmnopqrst";
  it("warns, in words that claim neither way, when the outcome is unknown; errors only on a definite refusal", async () => {
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSetTemplateHidden(), { wrapper });
    fetchMock.mockResolvedValueOnce(Response.json({ error: VISIBILITY_OUTCOME_UNKNOWN_MESSAGE, code: "outcome_unknown" }, { status: 502 }));
    result.current.mutate({ cloudId: ID, hidden: false });
    await waitFor(() => expect(toast.warning).toHaveBeenLastCalledWith(VISIBILITY_OUTCOME_UNKNOWN_MESSAGE));
    // libi's own server never answered: the route may have run — unknown as well, not raw network text.
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed: RAW NETWORK TEXT"));
    result.current.mutate({ cloudId: ID, hidden: true });
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(2));
    expect(vi.mocked(toast.warning).mock.calls[1][0]).toBe(VISIBILITY_OUTCOME_UNKNOWN_MESSAGE);
    expect(toast.error).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Too many changes. Try again in a minute.", code: "rate_limited" }, { status: 429 }));
    result.current.mutate({ cloudId: ID, hidden: true });
    await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith("Too many changes. Try again in a minute."));
  });

  // A-F live check N1: the Public tab reflects a hide or a show made here at once — the catalog route
  // notes the change and re-checks its copy, so the catalog query is re-read along with /mine.
  it("a hide or a show re-reads /mine and the catalog, whatever the answer", async () => {
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useSetTemplateHidden(), { wrapper });
    fetchMock.mockResolvedValueOnce(Response.json({ template: { id: ID } }));
    result.current.mutate({ cloudId: ID, hidden: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([["templates", "cloud", "mine"], ["templates", "catalog"]]);
  });
});
