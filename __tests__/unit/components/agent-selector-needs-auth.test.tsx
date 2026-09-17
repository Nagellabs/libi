// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ProviderInfo } from "@/lib/editor-state-context";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";

/**
 * `available` and READINESS answer different questions. An installed agent is
 * `available: true` — and it is still unusable until the user signs in. The
 * selector used to paint the status dot green the moment `_activeAgentId` was
 * set, which is before anything has been proven, so an agent whose every
 * `session/new` is rejected looked connected.
 */

let readiness: AgentReadiness = { state: "unknown" };
const selectAgent = vi.fn();
const reloadAgentProviders = vi.fn();

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
    reloadAgentProviders,
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
  message: "Codex isn't signed in on this machine.",
};

/** The trigger's dot is the first rounded-full span in the document. */
function triggerDotClass(): string {
  return (
    document.querySelector("button span.rounded-full")?.className ?? ""
  );
}

function openMenu() {
  render(<AgentSelector />);
  fireEvent.click(screen.getByText("Codex", { selector: "span" }));
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
    openMenu();

    expect(screen.getByText("Sign-in required")).toBeInTheDocument();
    expect(
      screen.getByText("Codex isn't signed in on this machine."),
    ).toBeInTheDocument();

    // An installed agent stays selectable — the badge is information, not a lock.
    fireEvent.click(screen.getAllByText("Codex").at(-1)!);
    expect(selectAgent).toHaveBeenCalledWith("codex");
  });

  it("says its one line and links to Set up in Agents for that agent, with no Install or Sign-in button", () => {
    readiness = NEEDS_AUTH;
    openMenu();

    const link = screen.getByText("Set up in Agents").closest("a");
    expect(link).toHaveAttribute("href", "/agents?tab=agents&agent=codex");
    expect(link!.className).toContain("cursor-pointer");
    expect(screen.queryByRole("button", { name: /install|retry|sign in/i })).toBeNull();
  });

  it("shows no badge and no setup link for a healthy agent", () => {
    readiness = { state: "ready" };
    openMenu();
    expect(screen.queryByText("Sign-in required")).toBeNull();
    expect(screen.queryByText("Set up in Agents")).toBeNull();
  });
});
