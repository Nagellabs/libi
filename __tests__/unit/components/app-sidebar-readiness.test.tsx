// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";

/**
 * The measured bug, in one sentence: selecting Codex on a machine where codex
 * is installed-but-not-signed-in produced a permanently DISABLED "+" whose
 * tooltip read "Preparing a new chat session…" — an assertion of progress for a
 * state that can never finish, because the standby session's `session/new` is
 * rejected with `-32000 Authentication required` every time.
 *
 * The string itself is fine — it is honest while a standby is genuinely being
 * replenished. What must never happen is rendering it for `needs-auth`.
 */

const PREPARING = "Preparing a new chat session…";

const createSessionWithResult = vi.fn();
const createSession = vi.fn();
const createTerminalMutate = vi.fn();
const selectAgent = vi.fn();
const setActiveTerminalId = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
const routerPush = vi.fn();

let readiness: AgentReadiness = { state: "unknown" };
let canCreate = true;
let activeProviderId: string | null = "codex";

vi.mock("sonner", () => ({
  toast: { error: toastError, info: toastInfo, success: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/editor",
  useRouter: () => ({ push: routerPush }),
}));

vi.mock("next/link", () => ({
  default: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    agentProviders: [
      { id: "codex", name: "Codex", available: true, capabilities: { canListSessions: false } },
    ],
    activeProviderId,
    isAgentConnecting: false,
    selectAgent,
    terminalCliId: "codex",
    setActiveTerminalId,
    sessionList: {
      sessions: [],
      groups: [],
      isLoading: false,
      isCreating: false,
      canCreate,
      activeAgentId: activeProviderId,
      readiness,
      readinessFor: () => readiness,
      createError: null,
      activeSessionId: null,
      setActiveSessionId: vi.fn(),
      createSession,
      createSessionWithResult,
      switchSession: vi.fn(),
      refresh: vi.fn(),
    },
  }),
}));

vi.mock("@/lib/queries/runtime", () => ({ useRuntimeInfo: () => ({ data: null }) }));
vi.mock("@/lib/queries/runtime-update", () => ({
  useRuntimeUpdate: () => ({ data: null }),
  // The sidebar also imports these to drive the install spinner/progress bar
  // and the update dot (either channel, offer or restart-ready).
  isInstallInFlight: () => false,
  isShellInstallInFlight: () => false,
  updateOffer: () => null,
  restartOffer: () => null,
  blockedShellUpdate: () => null,
}));
vi.mock("@/lib/queries/terminals", () => ({
  useTerminalSessions: () => ({ data: [] }),
  useCreateTerminal: () => ({ mutateAsync: createTerminalMutate, isPending: false }),
}));

// Child surfaces are irrelevant to the "+" button's honesty.
vi.mock("@/components/sessions/agent-selector", () => ({ default: () => <div /> }));
vi.mock("@/components/sessions/sidebar-session-list", () => ({ default: () => <div /> }));
vi.mock("@/components/terminal/cli-preset-selector", () => ({ default: () => <div /> }));
vi.mock("@/components/sessions/codex-connect-nudge", () => ({
  CodexConnectNudge: () => <div />,
}));
vi.mock("@/components/layout/theme-toggle", () => ({ ThemeToggle: () => <div /> }));

// The sidebar chrome is shadcn/base-ui plumbing (cookies, matchMedia, context)
// that has nothing to do with what's under test.
vi.mock("@/components/ui/sidebar", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Sidebar: Pass,
    SidebarContent: Pass,
    SidebarFooter: Pass,
    SidebarGroup: Pass,
    SidebarGroupLabel: Pass,
    SidebarHeader: Pass,
    SidebarMenu: Pass,
    SidebarMenuButton: ({ children }: { children?: React.ReactNode }) => (
      <button type="button">{children}</button>
    ),
    SidebarMenuItem: Pass,
    SidebarRail: () => <div />,
    useSidebar: () => ({ toggleSidebar: vi.fn() }),
  };
});

// Render tooltip content inline so the copy is assertable without hovering.
vi.mock("@/components/ui/tooltip", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Tooltip: Pass,
    TooltipProvider: Pass,
    TooltipContent: Pass,
    TooltipTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  };
});

const { AppSidebar } = await import("@/components/layout/app-sidebar");

const NEEDS_AUTH: AgentReadiness = {
  state: "needs-auth",
  agentId: "codex",
  message: "Codex is installed but not signed in.",
  remedy: {
    label: "Sign in to Codex",
    command: "/libi/codex login",
    detail: "Runs the Codex engine libi already ships — nothing to install.",
  },
};

/** The "+": the only aria-labelled button wrapping an icon. (The
 *  icon-collapsed agent status dot is also aria-labelled but holds a plain
 *  span, and it precedes this one in the DOM.) */
function newChatButton(): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") && b.querySelector("svg"),
  );
  if (!btn) throw new Error("New chat button not rendered");
  return btn as HTMLButtonElement;
}

describe("AppSidebar — the New chat button under an unusable agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readiness = { state: "unknown" };
    canCreate = true;
    activeProviderId = "codex";
  });

  it("never renders the 'Preparing…' copy when the agent needs auth", () => {
    readiness = NEEDS_AUTH;
    // The exact live repro: the standby failed, so canCreate is false too.
    canCreate = false;
    render(<AppSidebar />);

    expect(screen.queryByText(PREPARING)).not.toBeInTheDocument();
    expect(
      document.querySelector(`[aria-label="${PREPARING}"]`),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(PREPARING);
  });

  it("says the real reason and offers the remedy", () => {
    readiness = NEEDS_AUTH;
    canCreate = false;
    render(<AppSidebar />);

    const label = newChatButton().getAttribute("aria-label") ?? "";
    expect(label).toContain("Codex is installed but not signed in.");
    expect(label).toContain("Sign in to Codex");
  });

  it("leaves the button ENABLED so the remedy is reachable", () => {
    readiness = NEEDS_AUTH;
    canCreate = false;
    render(<AppSidebar />);
    expect(newChatButton()).not.toBeDisabled();
  });

  it("clicking it opens libi's terminal with the sign-in command, not a doomed POST", async () => {
    readiness = NEEDS_AUTH;
    canCreate = false;
    createTerminalMutate.mockResolvedValue({ id: "term-1" });
    render(<AppSidebar />);

    fireEvent.click(newChatButton());

    // The command rides along with the SPAWN request. It used to be pasted
    // from the client after the fact, which silently lost it on a user's first
    // terminal — the view is a dynamic import that hadn't mounted yet. So
    // asserting the command is handed over here is the point of this test, not
    // just that a shell was asked for.
    await waitFor(() =>
      expect(createTerminalMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          cliId: "shell",
          initialInput: expect.stringContaining("login"),
        }),
      ),
    );
    expect(selectAgent).toHaveBeenCalledWith("terminal");
    expect(setActiveTerminalId).toHaveBeenCalledWith("term-1");
    // It must NOT fire a session POST it knows will be rejected.
    expect(createSessionWithResult).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("still says 'Preparing…' for a standby that IS genuinely being replenished", () => {
    readiness = { state: "unknown" };
    canCreate = false;
    render(<AppSidebar />);
    expect(newChatButton().getAttribute("aria-label")).toBe(PREPARING);
  });

  it("surfaces a failed session creation instead of swallowing it", async () => {
    readiness = { state: "unknown" };
    canCreate = true;
    createSessionWithResult.mockResolvedValue({
      sessionId: null,
      error: "Authentication required",
    });
    render(<AppSidebar />);

    fireEvent.click(newChatButton());

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Authentication required"),
    );
    expect(routerPush).not.toHaveBeenCalled();
  });
});
