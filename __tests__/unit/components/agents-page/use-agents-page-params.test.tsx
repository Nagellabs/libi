// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { followSearch, freshAgentsUrl } from "../../../helpers/agents-page-url";

/**
 * `useClearAgentParam` drops `?agent=` once the Agents tab has acted on it,
 * and nothing else: `tab` keeps the user on the same tab and `from` keeps Back
 * to chat pointing at the chat that sent them.
 */

const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => {
    followSearch(search);
    return { replace };
  },
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(search),
}));
let activeProviderId: string | null = null;
vi.mock("@/lib/editor-state-context", () => ({ useEditorState: () => ({ activeProviderId }) }));
import { useAgentsPageParams, useClearAgentParam, useSetupAgent } from "@/components/agents-page/use-agents-page-params";

beforeEach(() => {
  replace.mockClear();
  search = "";
  activeProviderId = null;
  freshAgentsUrl();
});

describe("useClearAgentParam", () => {
  it("removes agent with router.replace and keeps every other param in order", () => {
    search = "tab=agents&agent=codex&from=sess-7&provider=fal";
    const { result } = renderHook(() => useClearAgentParam());
    result.current();
    expect(replace).toHaveBeenCalledWith("/agents?tab=agents&from=sess-7&provider=fal", { scroll: false });
  });

  it("leaves a bare path when agent was the only param", () => {
    search = "agent=claude-code";
    const { result } = renderHook(() => useClearAgentParam());
    result.current();
    expect(replace).toHaveBeenCalledWith("/agents", { scroll: false });
  });

  it("does not navigate when there is no agent param to remove", () => {
    search = "tab=providers&from=sess-7";
    const { result } = renderHook(() => useClearAgentParam());
    result.current();
    expect(replace).not.toHaveBeenCalled();
  });
});

/**
 * `useSetupAgent` is the ONE agent the setup tabs show: the URL's `setupAgent`,
 * else the sidebar's agent. A pick shows at once and goes into the URL, which
 * is how the other setup tab sees it.
 */
describe("useSetupAgent", () => {
  it("is the URL's setupAgent, else the sidebar's agent, else Claude Code; junk in the URL reads as absent", () => {
    for (const [s, sidebar, expected] of [
      ["setupAgent=codex", "claude-code", "codex"],
      ["setupAgent=claude-code", "codex", "claude-code"],
      ["", "codex", "codex"],
      ["", "claude-code", "claude-code"],
      ["", null, "claude-code"],
      ["setupAgent=gpt", "codex", "codex"],
    ] as const) {
      search = s;
      activeProviderId = sidebar;
      const { result, unmount } = renderHook(() => useSetupAgent());
      expect(result.current[0], `${s} / ${sidebar}`).toBe(expected);
      unmount();
    }
    expect(replace).not.toHaveBeenCalled();
  });

  it("a pick shows at once and is written with router.replace, keeping every other param", () => {
    search = "tab=providers&provider=fal&from=sess-7";
    const { result } = renderHook(() => useSetupAgent());
    act(() => result.current[1]("codex"));
    expect(result.current[0]).toBe("codex");
    expect(replace).toHaveBeenCalledWith("/agents?tab=providers&provider=fal&from=sess-7&setupAgent=codex", { scroll: false });
  });

  it("replaces a setupAgent already in the URL in place, and writes nothing when the URL already names the pick", () => {
    search = "tab=global-setup&setupAgent=codex&from=sess-7";
    const { result } = renderHook(() => useSetupAgent());
    act(() => result.current[1]("codex"));
    expect(replace).not.toHaveBeenCalled();
    act(() => result.current[1]("claude-code"));
    expect(result.current[0]).toBe("claude-code");
    expect(replace).toHaveBeenCalledWith("/agents?tab=global-setup&setupAgent=claude-code&from=sess-7", { scroll: false });
  });

  it("a new setupAgent in the URL (back/forward, a deep link) wins over an earlier pick", () => {
    search = "setupAgent=codex";
    const { result, rerender } = renderHook(() => useSetupAgent());
    act(() => result.current[1]("claude-code"));
    expect(result.current[0]).toBe("claude-code");
    search = "setupAgent=claude-code";
    rerender();
    expect(result.current[0]).toBe("claude-code");
    search = "setupAgent=codex";
    rerender();
    expect(result.current[0]).toBe("codex");
  });
});

/**
 * Next puts a `router.replace` URL into the address bar only once that
 * navigation lands, and the mocked router here never lands one. Each writer
 * builds from the URL as it is plus the write still on its way, so a write
 * right after another never drops what the other added.
 */
describe("URL writes that follow each other before the first has landed", () => {
  const renderWriters = () =>
    renderHook(() => ({ setupAgent: useSetupAgent(), page: useAgentsPageParams(), clearAgent: useClearAgentParam() }));

  it("an agent pick followed at once by a tab click keeps both", () => {
    search = "tab=providers&provider=fal&from=sess-7";
    const { result } = renderWriters();
    act(() => result.current.setupAgent[1]("codex"));
    act(() => result.current.page.setTab("skills"));
    expect(replace).toHaveBeenLastCalledWith("/agents?tab=skills&from=sess-7&setupAgent=codex", { scroll: false });
  });

  it("a tab click followed at once by an agent pick keeps both", () => {
    search = "tab=providers&from=sess-7";
    const { result } = renderWriters();
    act(() => result.current.page.setTab("global-setup"));
    act(() => result.current.setupAgent[1]("codex"));
    expect(replace).toHaveBeenLastCalledWith("/agents?tab=global-setup&from=sess-7&setupAgent=codex", { scroll: false });
  });

  it("an agent pick right after the agent param was cleared doesn't bring the param back", () => {
    search = "tab=agents&agent=codex&from=sess-7";
    const { result } = renderWriters();
    act(() => result.current.clearAgent());
    expect(replace).toHaveBeenLastCalledWith("/agents?tab=agents&from=sess-7", { scroll: false });
    act(() => result.current.setupAgent[1]("codex"));
    expect(replace).toHaveBeenLastCalledWith("/agents?tab=agents&from=sess-7&setupAgent=codex", { scroll: false });
    // Cleared already, so a second clear has nothing to write.
    act(() => result.current.clearAgent());
    expect(replace).toHaveBeenCalledTimes(2);
  });

  it("once the history entry has changed — the write landed, or back/forward — the next write starts from the URL as it is", () => {
    search = "tab=providers&from=sess-7";
    const { result, rerender } = renderWriters();
    act(() => result.current.setupAgent[1]("codex"));
    // The user went back to the URL from before the pick: the same address, on another history entry.
    act(() => window.history.replaceState({}, "", "/agents?tab=providers&from=sess-7"));
    act(() => result.current.page.setTab("skills"));
    expect(replace).toHaveBeenLastCalledWith("/agents?tab=skills&from=sess-7", { scroll: false });

    // A URL that landed with another pick in it is the start of the next write.
    search = "tab=skills&setupAgent=claude-code&from=sess-7";
    rerender();
    act(() => result.current.page.setTab("providers"));
    expect(replace).toHaveBeenLastCalledWith("/agents?tab=providers&setupAgent=claude-code&from=sess-7", { scroll: false });
  });
});
