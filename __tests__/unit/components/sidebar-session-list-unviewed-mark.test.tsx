// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";

/**
 * A session that finished while you were looking elsewhere goes silent
 * forever — nothing brings it up again. The sidebar is the only surface that
 * can say so, and it now does.
 *
 * Three marks compete for one row, so what these tests really pin is that a
 * row wears exactly ONE of them and that the right one wins. Whether the
 * underlying state is CORRECT (never set for the session on screen, cleared by
 * opening it, replaced when a new turn starts) is pinned separately against
 * the real SSE singleton in `__tests__/unit/chat/use-agent-chat-stream.test.tsx`.
 */

const WORKING = "Working…";
const UNVIEWED = "Finished, not viewed yet";

let generating = new Set<string>();
let unviewed = new Set<string>();
let pendingApprovals = new Map<string, number>();

// This suite has no global `clearMocks`, and `vi.clearAllMocks()` does not
// reset implementations — so the mocks read mutable module state that
// `beforeEach` re-establishes, rather than being re-stubbed per test.
vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  usePendingApprovalCount: (sessionId: string | null) =>
    sessionId ? pendingApprovals.get(sessionId) ?? 0 : 0,
  useSessionGenerating: (sessionId: string | null) =>
    sessionId ? generating.has(sessionId) : false,
  useSessionUnviewed: (sessionId: string | null) =>
    sessionId ? unviewed.has(sessionId) : false,
}));

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    // A concrete agent id has to go somewhere for the sidebar to render at
    // all; nothing in the marks may read it. The state-level suite proves
    // that with an agent that does not exist yet.
    activeProviderId: "claude-code",
    isAgentConnecting: false,
    agentProviders: [],
    sessionList: {
      groups: [
        {
          label: "Today",
          sessions: [
            { sessionId: "done", title: "Rendering the intro" },
            { sessionId: "quiet", title: "An old chat" },
          ],
        },
      ],
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

/** The row is the <li>; scoping to it is what proves the mark landed on the
 *  RIGHT session rather than merely somewhere on screen. */
function row(title: string): HTMLElement {
  const li = screen.getByText(title).closest("li");
  if (!li) throw new Error(`no row for ${title}`);
  return li;
}

const DONE = "Rendering the intro";
const QUIET = "An old chat";

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
  unviewed = new Set();
  pendingApprovals = new Map();
});

describe("SidebarSessionList — the unviewed-result mark", () => {
  it("marks the session that finished unseen, and only that one", async () => {
    unviewed.add("done");
    await renderList();

    expect(within(row(DONE)).getByLabelText(UNVIEWED)).toBeInTheDocument();
    expect(within(row(QUIET)).queryByLabelText(UNVIEWED)).toBeNull();
  });

  it("says nothing at all when every session has been seen", async () => {
    await renderList();
    expect(screen.queryByLabelText(UNVIEWED)).toBeNull();
  });

  it("is told apart from the other two marks by FORM, not by a fourth hue", async () => {
    // Some users cannot separate amber from a third warm colour, so the shape
    // has to carry the meaning: this one is a hollow ring in the sidebar's own
    // foreground grey — no status hue at all — against two filled dots. It is
    // also the only one of the three that is not urgent, so it must not move:
    // a static mark reads as "there's something here", not as an alert, and
    // there is no motion left for prefers-reduced-motion to have to still.
    unviewed.add("done");
    await renderList();

    const mark = screen.getByLabelText(UNVIEWED);
    expect(mark.className).toMatch(/\bborder\b|border-\[/);
    expect(mark.className).toMatch(/rounded-full/);
    expect(mark.className).not.toMatch(/animate-/);
    expect(mark.className).not.toMatch(/amber|sky/);
    // And it is not a spinner or "Loading…" text — the repo's loading
    // convention forbids both.
    expect(screen.queryByText(/loading/i)).toBeNull();
  });
});

describe("SidebarSessionList — one mark per row, in priority order", () => {
  // needs-approval > working > unviewed > nothing. A row wearing two marks is
  // three lookalikes in a column, which is worse than saying nothing.

  it("a live turn outranks a result you haven't opened", async () => {
    // The session is working again: whatever it finished last time is no
    // longer the thing to say about it.
    unviewed.add("done");
    generating.add("done");
    await renderList();

    const r = row(DONE);
    expect(within(r).getByLabelText(WORKING)).toBeInTheDocument();
    expect(within(r).queryByLabelText(UNVIEWED)).toBeNull();
  });

  it("a pending approval outranks a result you haven't opened", async () => {
    unviewed.add("done");
    pendingApprovals.set("done", 1);
    await renderList();

    const r = row(DONE);
    expect(within(r).getByLabelText("1 pending approval")).toBeInTheDocument();
    expect(within(r).queryByLabelText(UNVIEWED)).toBeNull();
  });

  it("a pending approval wins even when all three conditions are true", async () => {
    // Blocked on the user beats everything: it is the only one of the three
    // that will not resolve itself.
    unviewed.add("done");
    generating.add("done");
    pendingApprovals.set("done", 2);
    await renderList();

    const r = row(DONE);
    expect(within(r).getByLabelText("2 pending approvals")).toBeInTheDocument();
    expect(within(r).queryByLabelText(WORKING)).toBeNull();
    expect(within(r).queryByLabelText(UNVIEWED)).toBeNull();
  });

  it("each of the four states renders its own mark and nothing else", async () => {
    // Walked as one table so a future fourth state can't quietly land on a row
    // that already has a mark.
    const cases: Array<{
      setup: () => void;
      expected: string | null;
    }> = [
      { setup: () => pendingApprovals.set("done", 1), expected: "1 pending approval" },
      { setup: () => generating.add("done"), expected: WORKING },
      { setup: () => unviewed.add("done"), expected: UNVIEWED },
      { setup: () => {}, expected: null },
    ];
    const allLabels = ["1 pending approval", WORKING, UNVIEWED];

    for (const { setup, expected } of cases) {
      generating = new Set();
      unviewed = new Set();
      pendingApprovals = new Map();
      setup();
      const { unmount } = await renderList();

      const r = row(DONE);
      for (const label of allLabels) {
        const found = within(r).queryByLabelText(label);
        if (label === expected) expect(found).toBeInTheDocument();
        else expect(found).toBeNull();
      }
      unmount();
    }
  });
});
