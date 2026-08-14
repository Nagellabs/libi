// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ProviderInfo } from "@/lib/editor-state-context";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";

/**
 * `available` and READINESS answer different questions. Codex ships its engine
 * inside libi, so `detectCodex` correctly reports it available on every
 * machine — and it is still unusable until the user signs in. The selector used
 * to paint the status dot green the moment `_activeAgentId` was set, which is
 * before anything has been proven, so an agent whose every `session/new` is
 * rejected looked connected.
 */

let readiness: AgentReadiness = { state: "unknown" };
const selectAgent = vi.fn();

const CODEX: ProviderInfo = {
  id: "codex",
  name: "Codex",
  available: true,
  capabilities: { canListSessions: false },
};

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    agentProviders: [CODEX],
    activeProviderId: "codex",
    isAgentConnecting: false,
    selectAgent,
    refreshAgentProviders: vi.fn(),
    sessionList: {
      readiness,
      readinessFor: () => readiness,
    },
  }),
}));

const { default: AgentSelector } = await import(
  "@/components/sessions/agent-selector"
);

const NEEDS_AUTH: AgentReadiness = {
  state: "needs-auth",
  agentId: "codex",
  message: "Codex is installed but not signed in.",
  remedy: {
    label: "Sign in to Codex",
    command: "/libi/codex login",
    detail: "Runs the Codex engine libi already ships.",
  },
};

/** The trigger's dot is the first rounded-full span in the document. */
function triggerDotClass(): string {
  return (
    document.querySelector("button span.rounded-full")?.className ?? ""
  );
}

describe("AgentSelector — needs-auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readiness = { state: "unknown" };
  });

  it("does not paint the dot green purely because an agent is active", () => {
    readiness = NEEDS_AUTH;
    render(<AgentSelector />);
    expect(triggerDotClass()).not.toContain("bg-emerald-500");
    expect(triggerDotClass()).toContain("bg-amber-400");
  });

  it("keeps the green dot when nothing has failed", () => {
    readiness = { state: "ready" };
    render(<AgentSelector />);
    expect(triggerDotClass()).toContain("bg-emerald-500");
  });

  it("badges the agent 'Sign-in required' and keeps it selectable", () => {
    readiness = NEEDS_AUTH;
    render(<AgentSelector />);
    fireEvent.click(screen.getByText("Codex", { selector: "span" }));

    expect(screen.getByText("Sign-in required")).toBeInTheDocument();
    expect(
      screen.getByText("Codex is installed but not signed in."),
    ).toBeInTheDocument();

    // Selectable: reaching the remedy requires selecting it.
    fireEvent.click(screen.getAllByText("Codex").at(-1)!);
    expect(selectAgent).toHaveBeenCalledWith("codex");
  });

  it("shows no badge for a healthy agent", () => {
    readiness = { state: "ready" };
    render(<AgentSelector />);
    fireEvent.click(screen.getByText("Codex", { selector: "span" }));
    expect(screen.queryByText("Sign-in required")).toBeNull();
  });
});
