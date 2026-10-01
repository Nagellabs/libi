// @vitest-environment jsdom
/**
 * The social React Query layer's behaviour, not its shape.
 *
 * Four things here have a way of regressing silently:
 *   - auto-refresh (b): poll ONLY while the page is visible, and refetch on
 *     focus. A 30 s interval that keeps running in a hidden tab is a provider
 *     rate limit waiting to happen.
 *   - a mutation invalidates the social prefix and NOT the world.
 *   - "libi is not connected" is DATA. A component must be able to render the
 *     connect panel from it; it is not an error boundary case.
 *   - no hook here opens an EventSource. libi has exactly one, in
 *     `use-agent-chat.ts`; the social refresh rides it via `refresh_query`.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  SOCIAL_POLL_MS,
  SocialApiError,
  socialKeys,
  socialConnection,
  retryAtFor,
  useSocialAccounts,
  useSocialStatus,
  useSocialPosts,
  useDeleteSocialPost,
  useConnectLibi,
  useCreateSocialPost,
  useComposeRequestId,
  isPartialPost,
} from "@/lib/queries/social";
import { useMusicPlan, type MusicPlanTarget } from "@/lib/queries/social-music";

const fetchMock = vi.fn();

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function jsonErr(status: number, body: unknown) {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

let client: QueryClient;

function wrap() {
  client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  Wrapper.displayName = "SocialQueryWrapper";
  return Wrapper;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  window.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  setVisibility("visible");
});

afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  setVisibility("visible");
});

describe("auto-refresh (b): poll while visible, never while hidden", () => {
  it("polls every SOCIAL_POLL_MS, stops when the document is hidden, and refetches on focus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValue(jsonOk({ accounts: [] }));

    renderHook(() => useSocialAccounts(), { wrapper: wrap() });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS + 50);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Hidden: the interval keeps ticking, but nothing may be fetched.
    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Back in view: refetch immediately rather than waiting out the interval.
    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("sends the list filter as query params and keys the cache by it", async () => {
    fetchMock.mockResolvedValue(jsonOk({ posts: [], page: 1, totalPages: 1 }));
    renderHook(() => useSocialPosts({ status: ["draft", "scheduled"], platform: "tiktok", page: 2, limit: 10 }), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("status=draft%2Cscheduled");
    expect(url).toContain("platform=tiktok");
    expect(url).toContain("page=2");
    expect(url).toContain("limit=10");
  });
});

describe("not connected is data, not an error", () => {
  it("useSocialStatus resolves with connected:false and no error", async () => {
    fetchMock.mockResolvedValue(
      jsonOk({
        providerId: "zernio",
        connected: false,
        needsReconnect: false,
        scopes: [],
        catalog: [],
        settings: { providerId: "zernio", timezone: null, defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 },
      }),
    );
    const { result } = renderHook(() => useSocialStatus(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.isError).toBe(false);
    expect(result.current.data?.connected).toBe(false);
    expect(socialConnection(result.current.data)).toBe("disconnected");
  });

  it("distinguishes never-connected from revoked, and from no provider chosen", () => {
    expect(socialConnection(undefined)).toBe("unknown");
    expect(socialConnection({ providerId: null, connected: false, needsReconnect: false })).toBe("no-provider");
    expect(socialConnection({ providerId: "zernio", connected: false, needsReconnect: false })).toBe("disconnected");
    expect(socialConnection({ providerId: "zernio", connected: false, needsReconnect: true })).toBe("needs-reconnect");
    expect(socialConnection({ providerId: "zernio", connected: true, needsReconnect: false })).toBe("connected");
  });

  it("a disabled dependent query never fetches and stays pending", async () => {
    const { result } = renderHook(() => useSocialAccounts(false), { wrapper: wrap() });
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.isPending).toBe(true);
    expect(result.current.isError).toBe(false);
  });
});

describe("rate limiting and revoked grants are never auto-retried", () => {
  it("a 429 fails once, carrying the provider's own retryAt", async () => {
    fetchMock.mockResolvedValue(jsonErr(429, { error: "rate_limited", retryAt: "2026-09-20T12:00:00.000Z" }));
    const { result } = renderHook(() => useSocialAccounts(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const err = result.current.error as SocialApiError;
    expect(err).toBeInstanceOf(SocialApiError);
    expect(err.status).toBe(429);
    expect(retryAtFor(err)).toBe("2026-09-20T12:00:00.000Z");
  });

  it("invents no retry moment when the provider gave none", async () => {
    fetchMock.mockResolvedValue(jsonErr(429, { error: "rate_limited", retryAt: null }));
    const { result } = renderHook(() => useSocialAccounts(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(retryAtFor(result.current.error)).toBeNull();
    expect(retryAtFor(new Error("boom"))).toBeNull();
  });

  it("a 401 fails once — the page shows Reconnect, not a retry storm", async () => {
    fetchMock.mockResolvedValue(jsonErr(401, { error: "needs_reconnect" }));
    const { result } = renderHook(() => useSocialAccounts(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((result.current.error as SocialApiError).status).toBe(401);
  });
});

describe("mutations invalidate the social prefix and nothing else", () => {
  it("useDeleteSocialPost invalidates exactly socialKeys.all", async () => {
    fetchMock.mockResolvedValue(jsonOk({ ok: true }));
    const { result } = renderHook(() => useDeleteSocialPost(), { wrapper: wrap() });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      await result.current.mutateAsync("post-1");
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: socialKeys.all });
    expect(socialKeys.all).toEqual(["social"]);
  });

  it("starting a sign-in invalidates nothing — the grant has not changed yet", async () => {
    fetchMock.mockResolvedValue(jsonOk({ url: "https://example.test/authorize" }));
    const { result } = renderHook(() => useConnectLibi(), { wrapper: wrap() });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("every social key lives under the one prefix the dispatcher invalidates", () => {
    const keys = [
      socialKeys.status,
      socialKeys.accounts,
      socialKeys.posts(),
      socialKeys.post("p1"),
      socialKeys.analytics("p1"),
      socialKeys.piecePosts("piece-1"),
      socialKeys.ads,
      socialKeys.creatorInfo("acc-1"),
    ];
    for (const k of keys) expect(k[0]).toBe("social");
  });
});

describe("one EventSource in the app, and it is not this file's", () => {
  it("opens none while the hooks run", async () => {
    const ctor = vi.fn();
    class FakeEventSource {
      constructor(...args: unknown[]) {
        ctor(...args);
      }
      close() {}
      addEventListener() {}
    }
    const prior = (globalThis as { EventSource?: unknown }).EventSource;
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    try {
      fetchMock.mockResolvedValue(jsonOk({ accounts: [] }));
      renderHook(() => useSocialAccounts(), { wrapper: wrap() });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(ctor).not.toHaveBeenCalled();
    } finally {
      (globalThis as { EventSource?: unknown }).EventSource = prior;
    }
  });

  it("constructs none in its source either (a prose mention is fine)", () => {
    const src = readFileSync(path.join(process.cwd(), "lib/queries/social.ts"), "utf8");
    expect(src).not.toMatch(/new\s+EventSource/);
  });
});

describe("a 207 is a distinct outcome, not a post", () => {
  /** The route's REAL 207 body (`socialErrorToResponse` -> `partial`): an
   *  error key and the per-target failures, and NO post. */
  const PARTIAL_BODY = {
    error: "partial",
    perTarget: [{ platform: "tiktok", accountId: "acct-tt", error: "TikTok rejected the video: unaudited client can only post to private accounts" }],
  };

  it("useCreateSocialPost returns the partial outcome instead of an undefined post", async () => {
    // 207 IS `res.ok` — which is the whole trap: the old typing promised
    // `{ post }`, the caller read `result.post.targets`, and the TypeError
    // surfaced as "libi could not confirm what Zernio did" over a post that
    // was already live on Instagram.
    fetchMock.mockResolvedValue({ ok: true, status: 207, json: async () => PARTIAL_BODY } as unknown as Response);
    const { result } = renderHook(() => useCreateSocialPost(), { wrapper: wrap() });
    let out: Awaited<ReturnType<typeof result.current.mutateAsync>> | undefined;
    await act(async () => {
      out = await result.current.mutateAsync({
        requestId: "11111111-2222-4333-8444-555555555555",
        content: "hi",
        media: [{ url: "https://media.zernio.test/temp/1_e.mp4", type: "video" }],
        targets: [],
        when: { mode: "now" },
        libi: { pieceId: "p1" },
      });
    });
    expect(out).toBeDefined();
    expect(isPartialPost(out!)).toBe(true);
    expect(isPartialPost(out!) && out!.perTarget).toEqual(PARTIAL_BODY.perTarget);
    // Nothing threw, and nothing pretended there was a post.
    expect((out as { post?: unknown }).post).toBeUndefined();
  });

  it("a 207 with no per-target list still reads as partial", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 207, json: async () => ({ error: "partial" }) } as unknown as Response);
    const { result } = renderHook(() => useCreateSocialPost(), { wrapper: wrap() });
    let out: unknown;
    await act(async () => {
      out = await result.current.mutateAsync({
        requestId: "11111111-2222-4333-8444-555555555555",
        content: "hi",
        media: [],
        targets: [],
        when: { mode: "now" },
        libi: { pieceId: "p1" },
      });
    });
    expect(isPartialPost(out as never)).toBe(true);
  });
});

describe("the compose request id comes from the server", () => {
  it("asks for the piece (and the post being edited) and never refetches", async () => {
    fetchMock.mockResolvedValue(jsonOk({ requestId: "11111111-2222-4333-8444-555555555555", source: "intent" }));
    const { result } = renderHook(() => useComposeRequestId("p1", "post_1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data?.requestId).toBe("11111111-2222-4333-8444-555555555555"));
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/social/request-id?");
    expect(url).toContain("pieceId=p1");
    expect(url).toContain("postId=post_1");
    // A second answer mid-compose would change the identity of the post being
    // composed — the one thing this hook exists to prevent.
    setVisibility("hidden");
    setVisibility("visible");
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("a music plan's new key keeps the previous plan on screen", () => {
  it("a changed override serves the last plan as placeholder until the new one answers — never a loading state", async () => {
    let answer!: (r: Response) => void;
    fetchMock.mockResolvedValueOnce(jsonOk({ targets: [{ plan: { mode: "attach" } }] }));
    const { result, rerender } = renderHook(({ target }: { target: MusicPlanTarget }) => useMusicPlan("p", target), {
      wrapper: wrap(),
      initialProps: { target: { platform: "tiktok", accountId: "tt" } as MusicPlanTarget },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
    rerender({ target: { platform: "tiktok", accountId: "tt", music: { mode: "attach", trackId: "t2" } } });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data).toEqual({ targets: [{ plan: { mode: "attach" } }] });
    await act(async () => answer(jsonOk({ targets: [{ plan: { mode: "attach", track: { id: "t2" } } }] })));
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
    expect(result.current.data).toEqual({ targets: [{ plan: { mode: "attach", track: { id: "t2" } } }] });
  });
});
