// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";

/**
 * Switching agents used to leave the PREVIOUS agent's state on screen for the
 * whole handshake — several seconds of a session list, and a sign-in or
 * install action, belonging to an agent the user had just switched away from.
 *
 * Nothing cleared it: `isLoading` is true only on first mount, and `sessions`
 * and `readiness` keep their old values until the new agent's arrive. The
 * sidebar's one job is saying which agent you are looking at, so being
 * confidently wrong about it is the worst state it can be in.
 */

let isAgentConnecting = false;
let activeProviderId: string | null = "claude-code";
let groups: Array<{ label: string; sessions: Array<{ sessionId: string; title: string }> }> = [];

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    activeProviderId,
    isAgentConnecting,
    agentProviders: [],
    sessionList: {
      groups,
      isLoading: false,
      activeSessionId: null,
      switchSession: vi.fn(),
      readiness: { state: "ready" },
      canListSessions: true,
    },
  }),
}));

vi.mock("@/hooks/agents/use-run-remedy-in-terminal", () => ({
  useRunRemedyInTerminal: () => vi.fn(() => Promise.resolve()),
}));
vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  usePendingApprovalCount: () => 0,
  useSessionGenerating: () => false,
  useSessionUnviewed: () => false,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/editor",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/sessions/terminal-session-list", () => ({
  default: () => <div data-testid="terminal-list" />,
}));

/** Session rows use SidebarMenuButton, which reads the sidebar context. */
function renderList(List: React.ComponentType) {
  return render(
    <SidebarProvider>
      <List />
    </SidebarProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // SidebarProvider reads a media query; jsdom has no matchMedia.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }),
  });
  isAgentConnecting = false;
  activeProviderId = "claude-code";
  groups = [
    { label: "Today", sessions: [{ sessionId: "s1", title: "A chat with the old agent" }] },
  ];
});

describe("SidebarSessionList — switching agents", () => {
  it("shows the previous agent's sessions when nothing is in flight", async () => {
    const { default: List } = await import("@/components/sessions/sidebar-session-list");
    renderList(List);
    expect(screen.getByText("A chat with the old agent")).toBeInTheDocument();
  });

  it("clears them the moment a switch starts, rather than after it finishes", async () => {
    isAgentConnecting = true;
    const { default: List } = await import("@/components/sessions/sidebar-session-list");
    const { container } = renderList(List);
    // The stale list is gone immediately...
    expect(screen.queryByText("A chat with the old agent")).toBeNull();
    // ...and something says work is happening. Skeletons, not a spinner —
    // the repo's loading convention is a shape that mirrors the real layout.
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it("covers a switch TO the terminal surface too", async () => {
    // The terminal branch sits after this check on purpose: switching to the
    // Terminal is just as much a switch, and rendering its list from
    // half-updated state has the same problem.
    isAgentConnecting = true;
    activeProviderId = "terminal";
    const { default: List } = await import("@/components/sessions/sidebar-session-list");
    renderList(List);
    expect(screen.queryByTestId("terminal-list")).toBeNull();
  });
});
