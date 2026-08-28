// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";

/**
 * A session keeps generating when you switch away from it — confirmed live on
 * 2026-08-26 (content grew 2,975 → 7,026 chars while backgrounded). But the
 * sidebar said nothing about it: the only row indicators were the amber
 * approval dot and a green "connected" dot, neither of which means "working
 * right now". So "is the agent still going in my other session?" could only be
 * answered by switching to that session — which is the whole problem.
 *
 * These tests pin the indicator's presence rules. Whether the underlying
 * status is CORRECT for an unmounted session is pinned separately, against the
 * real SSE singleton, in `__tests__/unit/chat/use-agent-chat-stream.test.tsx`.
 */

const WORKING = "Working…";

let generating = new Set<string>();
let pendingApprovals = new Map<string, number>();
let activeSessionId: string | null = null;

// This suite has no global `clearMocks`, and `vi.clearAllMocks()` does not
// reset implementations — so the mocks read mutable module state that
// `beforeEach` re-establishes, rather than being re-stubbed per test.
vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  usePendingApprovalCount: (sessionId: string | null) =>
    sessionId ? pendingApprovals.get(sessionId) ?? 0 : 0,
  useSessionGenerating: (sessionId: string | null) =>
    sessionId ? generating.has(sessionId) : false,
  // The third mark on these rows (a session that finished while you were
  // elsewhere) is pinned in `sidebar-session-list-unviewed-mark.test.tsx`;
  // here it is always off, so nothing can outrank or stand in for the dot
  // under test.
  useSessionUnviewed: () => false,
}));

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    activeProviderId: "claude-code",
    isAgentConnecting: false,
    agentProviders: [],
    sessionList: {
      groups: [
        {
          label: "Today",
          sessions: [
            { sessionId: "busy", title: "Rendering the intro" },
            { sessionId: "idle", title: "An old chat" },
          ],
        },
      ],
      isLoading: false,
      activeSessionId,
      switchSession: vi.fn(),
      readiness: { state: "ready" },
      canListSessions: true,
    },
  }),
}));

vi.mock("@/hooks/agents/use-run-remedy-in-terminal", () => ({
  useRunRemedyInTerminal: () => vi.fn(() => Promise.resolve()),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/editor",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/sessions/terminal-session-list", () => ({
  default: () => <div data-testid="terminal-list" />,
}));

async function renderList() {
  const { default: List } = await import(
    "@/components/sessions/sidebar-session-list"
  );
  return render(
    <SidebarProvider>
      <List />
    </SidebarProvider>,
  );
}

/** The row is the <li>; scoping to it is what proves the dot landed on the
 *  RIGHT session rather than merely somewhere on screen. */
function row(title: string): HTMLElement {
  const li = screen.getByText(title).closest("li");
  if (!li) throw new Error(`no row for ${title}`);
  return li;
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
  generating = new Set();
  pendingApprovals = new Map();
  activeSessionId = null;
});

describe("SidebarSessionList — the working indicator", () => {
  it("marks the session that is generating, and only that one", async () => {
    generating.add("busy");
    await renderList();

    expect(within(row("Rendering the intro")).getByLabelText(WORKING))
      .toBeInTheDocument();
    expect(within(row("An old chat")).queryByLabelText(WORKING)).toBeNull();
  });

  it("says nothing at all when no session is generating", async () => {
    await renderList();
    expect(screen.queryByLabelText(WORKING)).toBeNull();
  });

  it("shows it for the ACTIVE session too, not only backgrounded ones", async () => {
    // The composer that already reports this state only exists on /editor, so
    // suppressing the dot on the selected row would hide the state exactly
    // when the user navigates away from the editor.
    generating.add("busy");
    activeSessionId = "busy";
    await renderList();

    expect(within(row("Rendering the intro")).getByLabelText(WORKING))
      .toBeInTheDocument();
  });

  it("yields to a pending approval so a row never wears two dots", async () => {
    // A session blocked on a permission prompt is not working, it is waiting
    // on the user — and the amber dot carries the stronger call to action.
    generating.add("busy");
    pendingApprovals.set("busy", 1);
    await renderList();

    const busy = row("Rendering the intro");
    expect(within(busy).queryByLabelText(WORKING)).toBeNull();
    expect(within(busy).getByLabelText("1 pending approval")).toBeInTheDocument();
  });

  it("beats with opacity alone — no spinner, no 'Loading…', no ping, no ring", async () => {
    // The repo's loading convention forbids spinners, and this sits in a list
    // where a third lookalike dot would be worse than no indicator: motion is
    // what tells it apart from the flat amber and grey marks.
    //
    // The negative assertions are the valuable half, and each one is a bug this
    // mark actually shipped. It rendered as a SQUARE twice:
    //   1. `animate-ping` scaled a filled box. A scaled element is promoted to
    //      its own compositing layer and that layer rasterised without the
    //      border-radius, so the halo was a hard-edged square.
    //   2. A box-shadow ring moved the problem instead of fixing it: a running
    //      animation still promotes the layer, and a shadow's corner arc comes
    //      from the border-radius — which `rounded-full` sets to
    //      `calc(infinity * 1px)`, clamped to 2^24px and not survivable.
    //
    // Neither was visible to `getComputedStyle`, which reported a correct
    // radius throughout, and neither reproduced in a paused screenshot, because
    // a paused animation is not composited like a running one. So the guard has
    // to be structural: assert the techniques are absent, not that the output
    // looks right.
    generating.add("busy");
    const { container } = await renderList();

    expect(screen.queryByText(/loading/i)).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(container.querySelector(".animate-ping")).toBeNull();

    const dot = container.querySelector(".libi-working-beat");
    expect(dot).not.toBeNull();
    // Round by a radius the compositor can honour — NOT `rounded-full`, whose
    // clamped infinity value is what broke.
    expect(dot?.className).toMatch(/rounded-\[50%\]/);
    expect(dot?.className).not.toMatch(/rounded-full/);
  });
});
