// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";

/**
 * The chat that never starts.
 *
 * `showNoSession` used to render the literal "Starting a chat session…"
 * forever whenever `sessionId` never arrived — no timeout, no retry, no
 * error path, composer dead the whole time. This proves the states that
 * replace it:
 *
 *   1. An OBSERVED needs-auth or not-installed readiness renders ONE line —
 *      the server's own reason — and a Set up an agent link to that agent's
 *      setup on the Agents page. Setup happens there, not in the chat.
 *   2. Otherwise: a skeleton until SESSION_START_GRACE_MS elapses, then an
 *      honest "stuck" state with a Retry that re-runs selectAgent().
 */

const selectAgent = vi.fn();

let activeProviderId: string | null = "codex";
let readinessFor: (agentId: string) => AgentReadiness = () => ({ state: "unknown" });

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    activeProviderId,
    isAgentConnecting: false,
    selectAgent,
    agentProviders: [],
    agentProvidersLoaded: true,
    refreshAgentProviders: vi.fn(),
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

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  activeProviderId = "codex";
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

  it("offers ONE line and a Set up an agent button when the agent needs sign-in, pointing at that agent", async () => {
    readinessFor = (id) =>
      id === "codex"
        ? { state: "needs-auth", agentId: "codex", message: "Codex isn't signed in on this machine." }
        : { state: "unknown" };
    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    wrap(<ChatPanel sessionId={null} />);
    await waitFor(() => expect(screen.getByText("Codex isn't signed in on this machine.")).toBeInTheDocument());
    const btn = screen.getByRole("link", { name: /set up an agent/i });
    expect(btn).toHaveAttribute("href", "/agents?tab=agents&agent=codex");
    expect(btn.className).toContain("cursor-pointer");
    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /install/i })).not.toBeInTheDocument();
    // Never claims progress while pointing at the real fix.
    expect(screen.queryByText(/starting a chat session/i)).toBeNull();
  });

  it("does the same for not-installed", async () => {
    activeProviderId = "claude-code"; // the href names the ACTIVE agent; the file defaults to codex
    readinessFor = (id) =>
      id === "claude-code"
        ? { state: "not-installed", reason: "Claude Code isn't set up yet — open Agents to install it." }
        : { state: "unknown" };
    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    wrap(<ChatPanel sessionId={null} />);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /set up an agent/i })).toHaveAttribute(
        "href",
        "/agents?tab=agents&agent=claude-code",
      ),
    );
    expect(screen.getByText("Claude Code isn't set up yet — open Agents to install it.")).toBeInTheDocument();
  });

  it("points an agent the setup registry does not declare at the Agents tab itself", async () => {
    activeProviderId = "some-future-agent";
    readinessFor = () => ({ state: "not-installed", reason: "Future Agent support is missing from this install." });
    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    wrap(<ChatPanel sessionId={null} />);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /set up an agent/i })).toHaveAttribute("href", "/agents?tab=agents"),
    );
  });

  it("never turns the setup line into the stuck state, however long it stays up", async () => {
    readinessFor = () => ({ state: "needs-auth", agentId: "codex", message: "Codex isn't signed in on this machine." });
    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    vi.useFakeTimers();
    wrap(<ChatPanel sessionId={null} />);
    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });
    expect(screen.getByText("Codex isn't signed in on this machine.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
  });

  it("keeps the plain 'select an agent' sentence when no agent is chosen at all", async () => {
    activeProviderId = null;
    const { default: ChatPanel } = await import("@/components/chat/chat-panel");
    wrap(<ChatPanel sessionId={null} />);

    expect(screen.getByText(/select an agent to start chatting/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /set up an agent/i })).toBeNull();
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
