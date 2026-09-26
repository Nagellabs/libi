// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";

const replace = vi.hoisted(() => vi.fn());
let search = vi.hoisted(() => "");
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => "/templates",
  useSearchParams: () => new URLSearchParams(search),
}));

import { useTemplatesPageParams, VIEW_STORAGE_KEY } from "@/components/templates/templates-page/use-templates-page-params";

beforeEach(() => {
  search = "";
  replace.mockReset();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/templates");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useTemplatesPageParams — view", () => {
  it("defaults to cards", () => {
    const { result } = renderHook(() => useTemplatesPageParams());
    expect(result.current.view).toBe("cards");
  });

  it("uses the stored choice when the URL names none, and the URL over the stored one", () => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, "list");
    const stored = renderHook(() => useTemplatesPageParams());
    expect(stored.result.current.view).toBe("list");
    stored.unmount();
    search = "view=cards";
    const url = renderHook(() => useTemplatesPageParams());
    expect(url.result.current.view).toBe("cards");
  });

  it("setView writes ?view= and the stored choice, and switches at once", () => {
    search = "tab=mine";
    // The write builds on the live URL (window.location), keeping what is already there.
    window.history.replaceState(null, "", "/templates?tab=mine");
    const { result } = renderHook(() => useTemplatesPageParams());
    act(() => result.current.setView("list"));
    expect(result.current.view).toBe("list");
    expect(window.localStorage.getItem(VIEW_STORAGE_KEY)).toBe("list");
    expect(replace).toHaveBeenCalledWith(expect.stringMatching(/view=list/), { scroll: false });
    expect(String(replace.mock.calls[0][0])).toContain("tab=mine");
  });

  it("a throwing localStorage still switches", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { result } = renderHook(() => useTemplatesPageParams());
    expect(result.current.view).toBe("cards");
    act(() => result.current.setView("list"));
    expect(result.current.view).toBe("list");
    expect(replace).toHaveBeenCalledWith(expect.stringMatching(/view=list/), { scroll: false });
  });
});

// D2–D4 review M8: with `list` stored, the first paint (server render and
// hydration, which can't read localStorage) must not commit to Cards and then
// flip — the view is "pending" until the stored choice is read.
describe("useTemplatesPageParams — before the stored view can be read", () => {
  function Probe() {
    const p = useTemplatesPageParams();
    return <span>{`${p.view}:${p.viewPending}`}</span>;
  }

  it("the server render (no localStorage) says the view is pending", () => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, "list");
    expect(renderToString(<Probe />)).toContain("cards:true");
  });

  it("a view in the URL is never pending", () => {
    search = "view=list";
    expect(renderToString(<Probe />)).toContain("list:false");
  });

  it("on the client the stored choice is read at once: not pending", () => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, "list");
    const { result } = renderHook(() => useTemplatesPageParams());
    expect(result.current).toMatchObject({ view: "list", viewPending: false });
  });
});
