// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { followSearch, freshAgentsUrl } from "../../../helpers/agents-page-url";

const replace = vi.fn();
const push = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => {
    followSearch(search);
    return { replace, push };
  },
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(search),
}));
const setLastSessionId = vi.fn();
const setActiveSessionId = vi.fn();
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    setLastSessionId,
    sessionList: { sessions: [{ sessionId: "sess-42" }], setActiveSessionId },
  }),
}));
// The tab bodies are tested on their own; here only the page shell is under test.
vi.mock("@/components/agents-page/agents-tab/agents-tab", () => ({
  AgentsTab: ({ agent }: { agent: string | null }) => <div data-testid="agents-tab">agents:{agent ?? "-"}</div>,
}));
vi.mock("@/components/agents-page/skills-view", () => ({
  SkillsView: () => <div data-testid="skills-tab">skills</div>,
}));
vi.mock("@/components/agents-page/global-setup-tab/global-setup-tab", () => ({
  GlobalSetupTab: () => <div data-testid="global-setup-tab">global setup</div>,
}));
vi.mock("@/components/agents-page/libi-mcp-tab/libi-mcp-tab", () => ({
  LibiMcpTab: ({ extension }: { extension: string | null }) => <div data-testid="libi-mcp-tab">ext:{extension ?? "-"}</div>,
}));
vi.mock("@/components/agents-page/providers-tab/providers-tab", () => ({
  ProvidersTab: ({ provider }: { provider: string | null }) => <div data-testid="providers-tab">prov:{provider ?? "-"}</div>,
}));

import { AgentsPage } from "@/components/agents-page/agents-page";
import { parseAgentsPageParams } from "@/components/agents-page/use-agents-page-params";

function renderPage() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <AgentsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  search = "";
  freshAgentsUrl();
  replace.mockClear();
  push.mockClear();
  setLastSessionId.mockClear();
  setActiveSessionId.mockClear();
});

describe("parseAgentsPageParams", () => {
  it("defaults to the agents tab and nulls", () => {
    expect(parseAgentsPageParams(new URLSearchParams(""))).toEqual({
      tab: "agents", agent: null, provider: null, setupAgent: null, extension: null, from: null,
    });
  });
  it("reads every param and rejects junk", () => {
    expect(
      parseAgentsPageParams(
        new URLSearchParams("tab=providers&agent=codex&provider=fal&setupAgent=codex&extension=whisper&from=sess-1"),
      ),
    ).toEqual({ tab: "providers", agent: "codex", provider: "fal", setupAgent: "codex", extension: "whisper", from: "sess-1" });
    expect(parseAgentsPageParams(new URLSearchParams("tab=mcp&agent=gpt")).tab).toBe("agents");
    expect(parseAgentsPageParams(new URLSearchParams("agent=gpt")).agent).toBeNull();
  });
  it("reads setupAgent as claude-code or codex, and anything else as absent", () => {
    expect(parseAgentsPageParams(new URLSearchParams("setupAgent=claude-code")).setupAgent).toBe("claude-code");
    expect(parseAgentsPageParams(new URLSearchParams("setupAgent=codex")).setupAgent).toBe("codex");
    for (const junk of ["claude", "Codex", "gpt", ""]) {
      expect(parseAgentsPageParams(new URLSearchParams(`setupAgent=${junk}`)).setupAgent, junk).toBeNull();
    }
  });
});

describe("AgentsPage", () => {
  it("titles the page Agents and lists the five tabs in order, Agents first and selected", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Agents" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent?.trim());
    expect(tabs).toEqual(["Agents", "Global setup", "Skills", "Libi MCP", "Providers"]);
    expect(screen.getByTestId("agents-tab")).toBeInTheDocument();
    expect(screen.queryByTestId("skills-tab")).not.toBeInTheDocument();
  });

  it("opens the Global setup tab from ?tab=global-setup", () => {
    search = "tab=global-setup";
    renderPage();
    expect(screen.getByRole("tab", { name: "Global setup" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("global-setup-tab")).toBeInTheDocument();
  });

  it("opens the tab named in the URL and passes its param down", () => {
    search = "tab=providers&provider=elevenlabs";
    renderPage();
    expect(screen.getByTestId("providers-tab")).toHaveTextContent("prov:elevenlabs");
  });

  it("passes agent to the Agents tab and extension to the libi MCP tab", () => {
    search = "tab=agents&agent=codex";
    const { unmount } = renderPage();
    expect(screen.getByTestId("agents-tab")).toHaveTextContent("agents:codex");
    unmount();
    search = "tab=libi-mcp&extension=libi-tracking";
    renderPage();
    expect(screen.getByTestId("libi-mcp-tab")).toHaveTextContent("ext:libi-tracking");
  });

  it("clicking a tab writes ?tab= with router.replace and keeps the other params", () => {
    search = "tab=agents&from=sess-9";
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(replace).toHaveBeenCalledWith("/agents?tab=skills&from=sess-9", { scroll: false });
    expect(screen.getByTestId("skills-tab")).toBeInTheDocument();
    expect(screen.queryByTestId("agents-tab")).not.toBeInTheDocument();
  });

  it("a tab click drops the param that belongs to the tab being left and keeps from", () => {
    for (const [from, to, expected] of [
      ["tab=agents&agent=codex&from=sess-9", "Skills", "/agents?tab=skills&from=sess-9"],
      ["tab=libi-mcp&extension=libi-tracking&from=sess-9", "Providers", "/agents?tab=providers&from=sess-9"],
      ["tab=providers&provider=fal&from=sess-9", "Libi MCP", "/agents?tab=libi-mcp&from=sess-9"],
      // The agent the setup tabs show is a choice they share, not a filter: it stays.
      ["tab=providers&provider=fal&setupAgent=codex&from=sess-9", "Global setup", "/agents?tab=global-setup&setupAgent=codex&from=sess-9"],
      ["tab=global-setup&setupAgent=codex&from=sess-9", "Skills", "/agents?tab=skills&setupAgent=codex&from=sess-9"],
    ] as const) {
      search = from;
      replace.mockClear();
      const { unmount } = renderPage();
      fireEvent.click(screen.getByRole("tab", { name: to }));
      expect(replace).toHaveBeenCalledWith(expected, { scroll: false });
      unmount();
    }
  });

  it("follows the URL when its tab changes after mount (back/forward), even after a click", () => {
    search = "tab=agents";
    const { rerender } = renderPage();
    const qc = new QueryClient();
    const rerenderPage = () =>
      rerender(
        <QueryClientProvider client={qc}>
          <AgentsPage />
        </QueryClientProvider>,
      );
    // A click moves the tab locally; the mocked router never rewrites the URL.
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(screen.getByTestId("skills-tab")).toBeInTheDocument();

    search = "tab=providers&provider=fal";
    act(() => rerenderPage());
    expect(screen.getByTestId("providers-tab")).toHaveTextContent("prov:fal");
    expect(screen.queryByTestId("skills-tab")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");

    search = "tab=agents";
    act(() => rerenderPage());
    expect(screen.getByTestId("agents-tab")).toBeInTheDocument();
    expect(screen.queryByTestId("providers-tab")).not.toBeInTheDocument();
  });

  it("shows Back to chat only with from=, and it switches to that chat in the editor", () => {
    const { unmount } = renderPage();
    expect(screen.queryByRole("button", { name: /back to chat/i })).not.toBeInTheDocument();
    unmount();
    search = "tab=providers&provider=fal&from=sess-42";
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /back to chat/i }));
    expect(setActiveSessionId).toHaveBeenCalledWith("sess-42");
    expect(setLastSessionId).toHaveBeenCalledWith("sess-42");
    expect(push).toHaveBeenCalledWith("/editor");
  });

  it("Back to chat with an unknown from= opens the editor without switching chats", () => {
    search = "from=sess-gone";
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /back to chat/i }));
    expect(setActiveSessionId).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/editor");
  });

  it("gives the back button cursor-pointer (TabsTrigger already carries it — components/ui/tabs.tsx)", () => {
    search = "from=s";
    renderPage();
    expect(screen.getByRole("button", { name: /back to chat/i }).className).toContain("cursor-pointer");
  });
});
