// @vitest-environment jsdom
/**
 * `useConfirmPublishRequest` — "Publish publicly" on a review panel. The caller
 * passes the state of its rights box itself (BC review M1): the hook never
 * assumes it was ticked, so a later "Publish" button that forgets the rights
 * question can't publish — it is refused before anything is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
import { CloudRouteError, useConfirmPublishRequest } from "@/lib/queries/templates-cloud";
import { RIGHTS_REQUIRED } from "@/lib/templates/cloud/constants";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => Response.json({ ok: true, jobId: "job-1" }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function hook() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => useConfirmPublishRequest(), { wrapper }).result;
}

describe("useConfirmPublishRequest", () => {
  it("sends the confirm code and the caller's own tick", async () => {
    const result = hook();
    result.current.mutate({ id: "r 1", confirmCode: "c0de", rightsConfirmed: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/templates/cloud/publish-requests/r%201/confirm");
    expect(JSON.parse(String(init.body))).toStrictEqual({ confirmCode: "c0de", rightsConfirmed: true });
  });

  it("a caller without the tick can't confirm: refused with the route's words, nothing sent", async () => {
    const result = hook();
    const onError = vi.fn();
    result.current.mutate({ id: "r1", confirmCode: "c0de", rightsConfirmed: false }, { onError });
    await waitFor(() => expect(onError).toHaveBeenCalled());
    const e = onError.mock.calls[0][0] as CloudRouteError;
    expect(e).toBeInstanceOf(CloudRouteError);
    expect([e.message, e.status, e.code]).toEqual([RIGHTS_REQUIRED, 400, "rights_not_confirmed"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a caller that leaves the tick out altogether (an untyped call) is refused the same way", async () => {
    const result = hook();
    const onError = vi.fn();
    result.current.mutate({ id: "r1", confirmCode: "c0de" } as never, { onError });
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
