// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { parseSocialPageParams } from "@/components/social/social-page/use-social-page-params";

describe("parseSocialPageParams", () => {
  it("reads a valid tab from the URL", () => {
    expect(parseSocialPageParams(new URLSearchParams("tab=ads")).tab).toBe("ads");
  });

  it("junk — including the retired dashboard and analytics tabs — reads as the Posts default", () => {
    expect(parseSocialPageParams(new URLSearchParams("tab=nonsense")).tab).toBe("posts");
    expect(parseSocialPageParams(new URLSearchParams("")).tab).toBe("posts");
    expect(parseSocialPageParams(new URLSearchParams("tab=dashboard")).tab).toBe("posts");
    expect(parseSocialPageParams(new URLSearchParams("tab=analytics")).tab).toBe("posts");
  });

  it("reads the post deep link independently of the tab", () => {
    const params = parseSocialPageParams(new URLSearchParams("tab=posts&post=abc123"));
    expect(params).toEqual({ tab: "posts", post: "abc123", account: null });
    expect(parseSocialPageParams(new URLSearchParams("tab=posts")).post).toBeNull();
    expect(parseSocialPageParams(new URLSearchParams("tab=settings&account=acc-ig")).account).toBe("acc-ig");
    expect(parseSocialPageParams(new URLSearchParams("tab=settings")).account).toBeNull();
  });
});

// Same `router.replace` + pending-write pattern as
// `components/agents-page/use-agents-page-params.ts` — mirrored here rather
// than importing `__tests__/helpers/agents-page-url.ts`, which hardcodes
// `/agents`.
const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => {
    const want = search ? `?${search}` : "";
    if (window.location.pathname !== "/social" || window.location.search !== want) {
      window.history.replaceState({}, "", `/social${want}`);
    }
    return { replace };
  },
  usePathname: () => "/social",
  useSearchParams: () => new URLSearchParams(search),
}));

import { useSocialPageParams } from "@/components/social/social-page/use-social-page-params";

beforeEach(() => {
  replace.mockClear();
  search = "";
  window.history.replaceState({}, "", "/social");
});

describe("useSocialPageParams", () => {
  it("setTab writes tab with router.replace and keeps an existing post param", () => {
    search = "tab=posts&post=p1";
    const { result } = renderHook(() => useSocialPageParams());
    act(() => result.current.setTab("ads"));
    expect(result.current.tab).toBe("ads");
    expect(replace).toHaveBeenCalledWith("/social?tab=ads&post=p1", { scroll: false });
  });

  it("setPost adds ?post= without disturbing the tab", () => {
    search = "tab=posts";
    const { result } = renderHook(() => useSocialPageParams());
    act(() => result.current.setPost("post_1"));
    expect(replace).toHaveBeenCalledWith("/social?tab=posts&post=post_1", { scroll: false });
  });

  it("setPost(null) removes ?post=", () => {
    search = "tab=posts&post=post_1";
    const { result } = renderHook(() => useSocialPageParams());
    act(() => result.current.setPost(null));
    expect(replace).toHaveBeenCalledWith("/social?tab=posts", { scroll: false });
  });

  it("a tab click right after opening a post keeps both, even before the first write has landed", () => {
    search = "";
    const { result } = renderHook(() => useSocialPageParams());
    act(() => result.current.setPost("post_9"));
    act(() => result.current.setTab("ads"));
    expect(replace).toHaveBeenLastCalledWith("/social?post=post_9&tab=ads", { scroll: false });
  });
});
