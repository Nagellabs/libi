// @vitest-environment jsdom
/**
 * The creator's approval to publish, in the renderer: `useCreatorStatus` reads
 * libi's own route, `useApplyAsCreator` posts the form and re-reads the
 * status; a refusal is libi's copy as a CloudRouteError, for the form to show.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
import { toast } from "sonner";
import { CREATOR_STATUS_STALE_MS, CloudRouteError, templatesCloudKeys, useApplyAsCreator, useCreatorStatus, useImportCreatorKey } from "@/lib/queries/templates-cloud";
import { templateKeys } from "@/lib/queries/templates";
import { dispatchRefreshQueryData } from "@/lib/queries/dispatch-refresh-query";

let status: string | null = "none";
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  status = "none";
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/templates/cloud/creator" && !init?.method) return Response.json(status === null ? { status: null, error: "unreachable" } : { status });
    if (url === "/api/templates/cloud/creator" && init?.method === "POST") {
      status = "pending";
      return Response.json({ status: "pending" });
    }
    if (url === "/api/templates/cloud/key" && init?.method === "PUT") return Response.json({ hasKey: true, masked: "k…k", authorId: "a", nickname: "n", publishedHere: false });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function setup() {
  // The app's own defaults (components/providers/query-provider.tsx): the hook must bring its own focus rule.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, wrapper };
}

describe("creator approval hooks", () => {
  it("useCreatorStatus reads the route, and a site that can't be reached is status null, not an error", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useCreatorStatus(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ status: "none" }));
    expect(templatesCloudKeys.creator).toEqual(["templates-creator"]);
    status = null;
    const other = setup();
    const { result: offline } = renderHook(() => useCreatorStatus(), { wrapper: other.wrapper });
    await waitFor(() => expect(offline.current.data).toEqual({ status: null, error: "unreachable" }));
    expect(offline.current.isError).toBe(false);
  });

  it("useApplyAsCreator POSTs the form and re-reads the status", async () => {
    const { wrapper } = setup();
    const { result: s } = renderHook(() => useCreatorStatus(), { wrapper });
    await waitFor(() => expect(s.current.data?.status).toBe("none"));
    const { result } = renderHook(() => useApplyAsCreator(), { wrapper });
    result.current.mutate({ email: "a@b.co", note: "hooks" });
    await waitFor(() => expect(s.current.data?.status).toBe("pending"));
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ email: "a@b.co", note: "hooks" });
  });

  it("a refusal is the route's copy as a CloudRouteError, and is not toasted (the form shows it)", async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ error: "Your application to publish was already decided.", code: "creator_request_closed" }, { status: 409 }));
    const { wrapper } = setup();
    const { result } = renderHook(() => useApplyAsCreator(), { wrapper });
    const onError = vi.fn();
    result.current.mutate({ email: "a@b.co", note: "" }, { onError });
    await waitFor(() => expect(onError).toHaveBeenCalled());
    const e = onError.mock.calls[0][0] as CloudRouteError;
    expect(e).toBeInstanceOf(CloudRouteError);
    expect(e.message).toBe("Your application to publish was already decided.");
    expect(e.code).toBe("creator_request_closed");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("importing another creator key re-reads the approval: it belongs to the key", async () => {
    const { qc, wrapper } = setup();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useImportCreatorKey(), { wrapper });
    result.current.mutate({ key: "k".repeat(43), replace: true });
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: templatesCloudKeys.creator }));
  });
});

// Review M7: every read spends one of the site's 10-a-minute `creators` requests (GET and POST together,
// shared with libi.publish_template's gate) — so the status is re-read only on what can change it.
describe("when the creator's approval is re-read", () => {
  const reads = () => fetchMock.mock.calls.filter((c) => c[0] === "/api/templates/cloud/creator" && !(c[1] as RequestInit | undefined)?.method).length;
  let now = Date.now();
  beforeEach(() => {
    now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    focusManager.setFocused(undefined);
  });
  const focus = () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  };

  it("trusts a read for five minutes", () => {
    expect(CREATOR_STATUS_STALE_MS).toBe(5 * 60_000);
  });

  it("never on a template write: neither the templates refresh_query nor a templates invalidation re-reads it", async () => {
    const { qc, wrapper } = setup();
    const { result } = renderHook(() => useCreatorStatus(), { wrapper });
    await waitFor(() => expect(result.current.data?.status).toBe("none"));
    for (let i = 0; i < 5; i++) {
      dispatchRefreshQueryData({ queryKey: "templates" }, qc);
      await qc.invalidateQueries({ queryKey: templateKeys.all });
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(reads()).toBe(1);
  });

  it("on window focus at most once per five minutes", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useCreatorStatus(), { wrapper });
    await waitFor(() => expect(result.current.data?.status).toBe("none"));
    focus();
    now += CREATOR_STATUS_STALE_MS - 1_000;
    focus();
    await new Promise((r) => setTimeout(r, 20));
    expect(reads()).toBe(1);
    now += 2_000;
    status = "approved";
    focus();
    await waitFor(() => expect(result.current.data?.status).toBe("approved"));
    expect(reads()).toBe(2);
    focus();
    await new Promise((r) => setTimeout(r, 20));
    expect(reads()).toBe(2);
  });

  it("at once on a refusal for it (refresh_query templates-creator), on applying, and on a key import", async () => {
    const { qc, wrapper } = setup();
    const { result } = renderHook(() => useCreatorStatus(), { wrapper });
    await waitFor(() => expect(result.current.data?.status).toBe("none"));
    status = "rejected";
    dispatchRefreshQueryData({ queryKey: "templates-creator" }, qc);
    await waitFor(() => expect(result.current.data?.status).toBe("rejected"));
    expect(reads()).toBe(2);
    const { result: apply } = renderHook(() => useApplyAsCreator(), { wrapper });
    apply.current.mutate({ email: "a@b.co", note: "" });
    await waitFor(() => expect(reads()).toBe(3));
    const { result: imp } = renderHook(() => useImportCreatorKey(), { wrapper });
    imp.current.mutate({ key: "k".repeat(43), replace: true });
    await waitFor(() => expect(reads()).toBe(4));
  });
});
