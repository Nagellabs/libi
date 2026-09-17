// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
 * replenished. What must never happen is rendering it for an agent that is not
 * ready. A not-ready agent gets ONE line — the server's own reason — and a
 * "Set up in Agents" link to that agent's setup.
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
let isAgentConnecting = false;
let terminalCliId = "codex";
/** `/api/agents/status` as the terminal "+" sees it; undefined = still loading. */
let agentStatuses: Record<string, { ready: boolean }> | undefined;

vi.mock("sonner", () => ({
  toast: { error: toastError, info: toastInfo, success: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/editor",
  useRouter: () => ({ push: routerPush }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    agentProviders: [
      { id: "codex", name: "Codex", available: true, capabilities: { canListSessions: false } },
    ],
    activeProviderId,
    isAgentConnecting,
    selectAgent,
    terminalCliId,
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
vi.mock("@/lib/queries/agent-status", () => ({
  useAllAgentStatus: () => ({ data: agentStatuses }),
}));
vi.mock("@/lib/queries/terminals", () => ({
  useTerminalSessions: () => ({ data: [] }),
  useCreateTerminal: () => ({ mutateAsync: createTerminalMutate, isPending: false }),
}));

// Child surfaces are irrelevant to the "+" button's honesty.
vi.mock("@/components/sessions/agent-selector", () => ({ default: () => <div /> }));
vi.mock("@/components/sessions/sidebar-session-list", () => ({ default: () => <div /> }));
vi.mock("@/components/terminal/cli-preset-selector", () => ({ default: () => <div /> }));
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
  message: "Codex isn't signed in on this machine.",
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

function setUpLink(): HTMLElement | null {
  return screen.queryByRole("link", { name: /set up in agents/i });
}

/** A fresh query client per render keeps the tests independent of each
 *  other's caches. */
function renderSidebar() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AppSidebar />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  readiness = { state: "unknown" };
  canCreate = true;
  activeProviderId = "codex";
  isAgentConnecting = false;
  terminalCliId = "codex";
  agentStatuses = undefined;
});

describe("AppSidebar — the New chat button under an unusable agent", () => {
  it("never renders the 'Preparing…' copy when the agent needs auth", () => {
    readiness = NEEDS_AUTH;
    // The exact live repro: the standby failed, so canCreate is false too.
    canCreate = false;
    renderSidebar();

    expect(screen.queryByText(PREPARING)).not.toBeInTheDocument();
    expect(
      document.querySelector(`[aria-label="${PREPARING}"]`),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(PREPARING);
  });

  it("says the real reason and links to Agents", () => {
    readiness = NEEDS_AUTH;
    canCreate = false;
    renderSidebar();

    // The one line, readable without hovering…
    expect(screen.getByText("Codex isn't signed in on this machine.", { selector: "p" })).toBeInTheDocument();
    // …and the way to fix it, for THAT agent.
    const link = setUpLink()!;
    expect(link).toHaveAttribute("href", "/agents?tab=agents&agent=codex");
    expect(link.className).toContain("cursor-pointer");

    const label = newChatButton().getAttribute("aria-label") ?? "";
    expect(label).toContain("Codex isn't signed in on this machine.");
    expect(label).toContain("Set up in Agents");
  });

  it("leaves the button ENABLED so the setup is reachable", () => {
    readiness = NEEDS_AUTH;
    canCreate = false;
    renderSidebar();
    expect(newChatButton()).not.toBeDisabled();
  });

  it("clicking it opens the agent's setup in Agents, not a doomed POST or a terminal", async () => {
    readiness = NEEDS_AUTH;
    canCreate = false;
    renderSidebar();

    fireEvent.click(newChatButton());

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/agents?tab=agents&agent=codex"));
    expect(createSessionWithResult).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(createTerminalMutate).not.toHaveBeenCalled();
    expect(selectAgent).not.toHaveBeenCalled();
  });

  it("still says 'Preparing…' for a standby that IS genuinely being replenished, with no setup line", () => {
    readiness = { state: "unknown" };
    canCreate = false;
    renderSidebar();
    expect(newChatButton().getAttribute("aria-label")).toBe(PREPARING);
    expect(setUpLink()).toBeNull();
  });

  it("hides the setup line mid-switch, when readiness still describes the previous agent", () => {
    readiness = NEEDS_AUTH;
    isAgentConnecting = true;
    renderSidebar();
    expect(setUpLink()).toBeNull();
  });

  it("surfaces a failed session creation instead of swallowing it", async () => {
    readiness = { state: "unknown" };
    canCreate = true;
    createSessionWithResult.mockResolvedValue({
      sessionId: null,
      error: "Authentication required",
    });
    renderSidebar();

    fireEvent.click(newChatButton());

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Authentication required"),
    );
    expect(routerPush).not.toHaveBeenCalled();
  });
});

/**
 * The sidebar renders the active agent's readiness reason in the status dot's
 * title, the "+" button's tooltip and its one-line setup notice whenever the
 * agent is `not-installed` — so the retired "restart libi" dead end must not
 * appear in any of them, and the positive case must say where to go instead.
 */
describe("AppSidebar — a not-installed active agent points at Agents", () => {
  it("never renders 'restart libi' when the active agent's readiness is not-installed", () => {
    readiness = {
      state: "not-installed",
      reason: "Claude Code isn't set up yet — open Agents to install it.",
    };
    canCreate = false;
    activeProviderId = "claude-code";
    renderSidebar();

    expect(document.body.textContent).not.toContain("restart libi");
    expect(newChatButton().getAttribute("aria-label")).not.toContain("restart libi");
  });

  it("still says SOMETHING about the agent needing setup, not silence", () => {
    readiness = {
      state: "not-installed",
      reason: "Claude Code isn't set up yet — open Agents to install it.",
    };
    canCreate = false;
    activeProviderId = "claude-code";
    renderSidebar();

    const label = newChatButton().getAttribute("aria-label") ?? "";
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toBe(PREPARING);
  });

  it("points a not-installed Codex at its setup with Set up in Agents", () => {
    readiness = {
      state: "not-installed",
      reason: "Codex isn't set up yet — open Agents to install it.",
    };
    canCreate = false;
    activeProviderId = "codex";
    renderSidebar();

    const label = newChatButton().getAttribute("aria-label") ?? "";
    expect(label).toContain("Codex isn't set up yet");
    expect(label).toContain("Set up in Agents");
    expect(label).not.toContain("restart libi");
    expect(setUpLink()).toHaveAttribute("href", "/agents?tab=agents&agent=codex");
  });

  it("links an agent the setup registry does not declare to the Agents tab itself", () => {
    readiness = {
      state: "not-installed",
      reason: "Future Agent support is missing from this install.",
    };
    canCreate = false;
    activeProviderId = "some-future-agent";
    renderSidebar();

    expect(newChatButton().getAttribute("aria-label")).toContain(
      "Future Agent support is missing",
    );
    expect(setUpLink()).toHaveAttribute("href", "/agents?tab=agents");
  });
});

/**
 * On the Terminal surface the "+" launches the SELECTED CLI preset — by default
 * Claude Code. Gating only the dropdown left the preset that was already
 * selected free to launch, so a machine without that agent typed `claude` into
 * a shell and got `command not found` with nothing pointing at Agents.
 */
describe("AppSidebar — the New terminal button under a not-ready CLI preset", () => {
  beforeEach(() => {
    activeProviderId = "terminal";
    createTerminalMutate.mockResolvedValue({ id: "t-new" });
  });

  it("opens the selected preset's setup instead of creating a terminal when its agent is not ready", async () => {
    terminalCliId = "claude-code";
    agentStatuses = { "claude-code": { ready: false }, codex: { ready: true } };
    renderSidebar();

    fireEvent.click(newChatButton());

    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/agents?tab=agents&agent=claude-code"),
    );
    expect(createTerminalMutate).not.toHaveBeenCalled();
    expect(setActiveTerminalId).not.toHaveBeenCalled();
    expect(newChatButton().getAttribute("aria-label")).toContain("Set up in Agents");
  });

  it("treats a preset agent missing from the status response as not ready", async () => {
    terminalCliId = "codex";
    agentStatuses = {};
    renderSidebar();

    fireEvent.click(newChatButton());

    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/agents?tab=agents&agent=codex"),
    );
    expect(createTerminalMutate).not.toHaveBeenCalled();
  });

  it("creates the terminal when the selected preset's agent is ready", async () => {
    terminalCliId = "codex";
    agentStatuses = { "claude-code": { ready: false }, codex: { ready: true } };
    renderSidebar();

    fireEvent.click(newChatButton());

    await waitFor(() => expect(createTerminalMutate).toHaveBeenCalledWith("codex"));
    expect(routerPush).not.toHaveBeenCalledWith(expect.stringContaining("/agents"));
  });

  it("never gates the plain Shell", async () => {
    terminalCliId = "shell";
    agentStatuses = {};
    renderSidebar();

    fireEvent.click(newChatButton());

    await waitFor(() => expect(createTerminalMutate).toHaveBeenCalledWith("shell"));
    expect(routerPush).not.toHaveBeenCalledWith(expect.stringContaining("/agents"));
  });

  it("gates nothing while the agent status is still loading", async () => {
    terminalCliId = "claude-code";
    agentStatuses = undefined;
    renderSidebar();

    fireEvent.click(newChatButton());

    await waitFor(() => expect(createTerminalMutate).toHaveBeenCalledWith("claude-code"));
    expect(routerPush).not.toHaveBeenCalledWith(expect.stringContaining("/agents"));
  });
});
