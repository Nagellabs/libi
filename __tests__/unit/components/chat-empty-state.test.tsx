// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";

/**
 * Task 11: the chat that never starts.
 *
 * `showNoSession` used to render the literal "Starting a chat session…"
 * forever whenever `sessionId` never arrived — no timeout, no retry, no
 * error path, composer dead the whole time. This proves the three states
 * that replace it:
 *
 *   1. An OBSERVED needs-auth readiness renders the shared AgentSetupCard in
 *      sign-in mode, right where the user is already looking.
 *   2. An OBSERVED not-installed readiness (with a declared install step)
 *      renders the card in install mode.
 *   3. Otherwise: a skeleton until SESSION_START_GRACE_MS elapses, then an
 *      honest "stuck" state with a Retry that re-runs selectAgent().
 */

const selectAgent = vi.fn();
const refreshAgentProviders = vi.fn();
const startInstallMutate = vi.fn();
const cancelInstallMutate = vi.fn();

let activeProviderId: string | null = "codex";
let isAgentConnecting = false;
let installJob: { job: unknown } = { job: null };
let startInstall: { mutate: typeof startInstallMutate; isPending?: boolean; error?: Error | null } = {
  mutate: startInstallMutate,
};
// ChatPanel is React.memo'd, so re-rendering it with identical props bails
// out — which is exactly what a plain `rerender()` would do. The install
// query is therefore modelled as a real external store the component
// subscribes to, so pushing a new job status re-renders the panel the same
// way a poll landing would.
const jobListeners = new Set<() => void>();
// One stable snapshot object — useSyncExternalStore re-reads it on every
// render and loops forever if the reference changes without a notify.
let installSnapshot: { data: { job: unknown } } = { data: installJob };
function pushInstallJob(next: { job: unknown }) {
  installJob = next;
  installSnapshot = { data: next };
  act(() => {
    for (const listener of jobListeners) listener();
  });
}
let readinessFor: (agentId: string) => AgentReadiness = () => ({ state: "unknown" });

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    activeProviderId,
    isAgentConnecting,
    selectAgent,
    agentProviders: [],
    agentProvidersLoaded: true,
    refreshAgentProviders,
    prefilledMessage: null,
    setPrefilledMessage: vi.fn(),
    onboardingDemoOffer: false,
    setOnboardingDemoOffer: vi.fn(),
    sessionList: {
      readiness: readinessFor(activeProviderId ?? ""),
      readinessFor: (agentId: string) => readinessFor(agentId),
    },
  }),
}));

vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  useAgentChat: () => ({
    messages: [],
    sendMessage: vi.fn(),
    retryMessage: vi.fn(),
    isStreaming: false,
    cancelStream: vi.fn(),
    error: null,
    isLoading: false,
    sessionReady: false,
    cancelMessage: vi.fn(),
    status: "idle",
  }),
  subscribeBroadcast: () => () => {},
  sessionContextEmitter: { on: () => () => {}, emit: vi.fn() },
  // The model picker's query hook subscribes to this at mount; a partial mock
  // of this module has to carry it or every ChatPanel render throws.
  sessionModelEmitter: { on: () => () => {}, emit: vi.fn() },
}));

vi.mock("@/lib/queries/files", () => ({
  useFiles: () => ({ data: [] }),
  useGlobalFiles: () => ({ data: [] }),
  useFileUpload: () => ({ upload: vi.fn() }),
}));

vi.mock("@/hooks/use-scroll-to-bottom", () => ({
  useScrollToBottom: () => ({
    containerRef: { current: null },
    isAtBottom: true,
    scrollToBottom: vi.fn(),
    restoreSavedPosition: vi.fn(),
  }),
}));


// `useRunRemedyInTerminal` reaches for the app router and the terminal
// mutation, neither of which exists in this render. It has its own tests; here
// we only care THAT the card asks it to open a terminal, and with what.
const runRemedyInTerminal = vi.fn(() => Promise.resolve());
vi.mock("@/hooks/agents/use-run-remedy-in-terminal", () => ({
  useRunRemedyInTerminal: () => runRemedyInTerminal,
}));

vi.mock("@/lib/queries/agent-setup", async () => {
  const actual = await vi.importActual<typeof import("@/lib/queries/agent-setup")>(
    "@/lib/queries/agent-setup",
  );
  return {
    ...actual,
    useAgentInstall: () =>
      React.useSyncExternalStore(
        (onChange: () => void) => {
          jobListeners.add(onChange);
          return () => jobListeners.delete(onChange);
        },
        () => installSnapshot as never,
        () => installSnapshot as never,
      ),
    useStartAgentInstall: () => startInstall,
    useCancelAgentInstall: () => ({ mutate: cancelInstallMutate }),
  };
});

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  activeProviderId = "codex";
  isAgentConnecting = false;
  installJob = { job: null };
  installSnapshot = { data: installJob };
  startInstall = { mutate: startInstallMutate, isPending: false, error: null };
  readinessFor = () => ({ state: "unknown" });
  vi.useRealTimers();
});

describe("ChatPanel — the chat that never starts", () => {
  it("shows a skeleton, not the sentence, before the grace period elapses", async () => {
    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    vi.useFakeTimers();
    wrap(<ChatPanel sessionId={null} />);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.queryByText(/starting a chat session/i)).toBeNull();
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("stops claiming progress once the grace period has passed, and Retry re-runs selectAgent", async () => {
    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    vi.useFakeTimers();
    wrap(<ChatPanel sessionId={null} />);

    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });

    expect(screen.queryByText(/starting a chat session/i)).toBeNull();
    const retryButton = screen.getByRole("button", { name: /retry/i });
    expect(retryButton).toBeTruthy();

    vi.useRealTimers();
    fireEvent.click(retryButton);
    expect(selectAgent).toHaveBeenCalledWith("codex");
  });

  it("offers sign-in in the chat when the agent is not signed in (observed needs-auth)", async () => {
    readinessFor = (agentId) =>
      agentId === "codex"
        ? {
            state: "needs-auth",
            agentId: "codex",
            message: "Codex is installed but not signed in.",
            remedy: {
              label: "Sign in to Codex",
              command: "/very/long/resolved/path/to/codex login",
              detail: "Runs the Codex engine libi already ships.",
            },
          }
        : { state: "unknown" };

    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    const { container } = wrap(<ChatPanel sessionId={null} />);

    expect(screen.getByRole("button", { name: /sign in to codex/i })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    const card = container.querySelector('[data-slot="agent-setup-card"]');
    expect(card?.getAttribute("data-surface")).toBe("chat");
    // Never claims progress while offering the real fix.
    expect(screen.queryByText(/starting a chat session/i)).toBeNull();
  });

  it("signs in when you press Sign in, instead of retrying the call that just failed", async () => {
    // This card exists BECAUSE codex answered `Authentication required`. Its
    // button used to call selectAgent again — the identical call, the
    // identical rejection — so the control that promised a sign-in was a loop.
    // With an observed remedy in hand there is nothing to find out: open the
    // terminal on the command that fixes it.
    const remedy = {
      label: "Sign in to Codex",
      command: "/very/long/resolved/path/to/codex login",
      detail: "Runs the Codex engine libi already ships.",
    };
    readinessFor = (agentId) =>
      agentId === "codex"
        ? {
            state: "needs-auth",
            agentId: "codex",
            message: "Codex is installed but not signed in.",
            remedy,
          }
        : { state: "unknown" };

    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    const { container } = wrap(<ChatPanel sessionId={null} />);

    const card = container.querySelector('[data-slot="agent-setup-card"]') as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /sign in to codex/i }));

    await waitFor(() =>
      expect(runRemedyInTerminal).toHaveBeenCalledWith(remedy, "codex", "chat"),
    );
    expect(selectAgent).not.toHaveBeenCalled();
  });

  it("hands the sign-in card the OBSERVED remedy command, not the short form", async () => {
    readinessFor = (agentId) =>
      agentId === "codex"
        ? {
            state: "needs-auth",
            agentId: "codex",
            message: "Codex is installed but not signed in.",
            remedy: {
              label: "Sign in to Codex",
              command: "/very/long/resolved/node_modules/path/to/codex login",
              detail: "Runs the Codex engine libi already ships.",
            },
          }
        : { state: "unknown" };

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    wrap(<ChatPanel sessionId={null} />);

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith(
      "/very/long/resolved/node_modules/path/to/codex login",
    );
  });

  it("offers install in the chat when the agent is not installed and declares an install step", async () => {
    activeProviderId = "claude-code";
    readinessFor = (agentId) =>
      agentId === "claude-code"
        ? { state: "not-installed", reason: "Claude Code is not installed." }
        : { state: "unknown" };

    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    const { container } = wrap(<ChatPanel sessionId={null} />);

    expect(screen.getByRole("button", { name: /install claude code/i })).toBeTruthy();
    const card = container.querySelector('[data-slot="agent-setup-card"]');
    expect(card?.getAttribute("data-surface")).toBe("chat");
  });

  it("keeps the plain 'select an agent' sentence when no agent is chosen at all", async () => {
    activeProviderId = null;
    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    wrap(<ChatPanel sessionId={null} />);

    expect(screen.getByText(/select an agent to start chatting/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("never lets the string 'restart libi' appear", async () => {
    readinessFor = () => ({ state: "unknown" });
    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    vi.useFakeTimers();
    wrap(<ChatPanel sessionId={null} />);
    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });
    expect(document.body.textContent).not.toMatch(/restart libi/i);
  });
});

/**
 * Finding 1: the install card that never clears.
 *
 * Chat derives `showInstall` from `readiness.state === "not-installed"`, and
 * `readinessByAgent` is written ONLY by the `agent-readiness` SSE broadcast
 * or the `/api/agent/start` response — `refreshAgentProviders()` does not
 * touch it. So the completed 250 MB install refreshed a list this surface
 * never reads, the card re-rendered "Install Claude Code" on a machine where
 * it now WAS installed, and pressing it again hit `matching_completed` and
 * did nothing. The only escape was re-selecting the agent or reloading.
 *
 * The other two surfaces are immune for reasons that don't transfer:
 * onboarding also invalidates its own detect query, the sidebar derives its
 * chip from `provider.available`. Chat is the one whose recovery step didn't
 * match its input — so its recovery is now the one that does: re-select the
 * agent, which is what actually re-derives readiness.
 */
describe("ChatPanel — a completed install clears the card", () => {
  const notInstalled = (agentId: string): AgentReadiness =>
    agentId === "claude-code"
      ? { state: "not-installed", reason: "Claude Code is not installed." }
      : { state: "unknown" };

  beforeEach(() => {
    activeProviderId = "claude-code";
    readinessFor = notInstalled;
  });

  it("stops offering the install once the job completes, and re-selects the agent", async () => {
    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    wrap(<ChatPanel sessionId={null} />);

    fireEvent.click(screen.getByRole("button", { name: /install claude code/i }));
    expect(startInstallMutate).toHaveBeenCalledWith("claude-code");

    pushInstallJob({
      job: { id: "job-1", status: "running", progressDone: 40, progressTotal: 250, error: null },
    });
    expect(screen.getByRole("progressbar")).toBeTruthy();

    // Readiness is deliberately NOT changed here: the SSE broadcast is what
    // would move it, and it has not fired. The card must clear anyway.
    pushInstallJob({
      job: { id: "job-1", status: "completed", progressDone: 250, progressTotal: 250, error: null },
    });

    expect(screen.queryByRole("button", { name: /install claude code/i })).toBeNull();
    expect(refreshAgentProviders).toHaveBeenCalled();
    // The recovery that matches chat's own input: re-running selectAgent is
    // what re-derives readiness from /api/agent/start.
    expect(selectAgent).toHaveBeenCalledWith("claude-code");
  });

  it("says something is happening during the Install POST round-trip", async () => {
    // Between the click and the refetch the button used to still read
    // "Install Claude Code" and stay enabled — an invitation to click again.
    startInstall = { mutate: startInstallMutate, isPending: true, error: null };
    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    wrap(<ChatPanel sessionId={null} />);

    const button = screen.getByRole("button", { name: /starting/i });
    expect(button).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^install claude code$/i })).toBeNull();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("shows a failed Install POST instead of silently doing nothing", async () => {
    startInstall = {
      mutate: startInstallMutate,
      isPending: false,
      error: new Error("Install failed to start (500)"),
    };
    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    wrap(<ChatPanel sessionId={null} />);

    expect(screen.getByText(/install failed to start \(500\)/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });
});
