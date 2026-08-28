// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
    setRightRegionMode: vi.fn(),
    refreshAgentProviders: vi.fn(),
    sessionList: {
      readiness,
      readinessFor: () => readiness,
    },
  }),
}));

// Task 10 wires the row to the same install-job query the connect-agent card
// uses. Codex is `available: true` in every test here, so the row never
// offers an Install chip regardless — this mock just keeps the component
// import side-effect-free (no react-query context needed).

// `useRunRemedyInTerminal` reaches for the app router, which this render does
// not mount. It has its own tests; nothing here exercises it.
vi.mock("@/hooks/agents/use-run-remedy-in-terminal", () => ({
  useRunRemedyInTerminal: () => vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/queries/agent-setup", async () => {
  const actual = await vi.importActual<typeof import("@/lib/queries/agent-setup")>(
    "@/lib/queries/agent-setup",
  );
  return {
    ...actual,
    useAgentInstall: () => ({ data: { job: null } }),
    useStartAgentInstall: () => ({ mutate: vi.fn() }),
    useCancelAgentInstall: () => ({ mutate: vi.fn() }),
  };
});

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

/** The selector reaches React Query through `useAgentSetupCardState` (the
 *  shared install-state derivation), so it needs a client in scope — the same
 *  provider the real app layout puts above it. */
function renderSelector() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AgentSelector />
    </QueryClientProvider>,
  );
}

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
    renderSelector();
    expect(triggerDotClass()).not.toContain("bg-emerald-500");
    expect(triggerDotClass()).toContain("bg-amber-400");
  });

  it("keeps the green dot when nothing has failed", () => {
    readiness = { state: "ready" };
    renderSelector();
    expect(triggerDotClass()).toContain("bg-emerald-500");
  });

  it("badges the agent 'Sign-in required' and keeps it selectable", () => {
    readiness = NEEDS_AUTH;
    renderSelector();
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
    renderSelector();
    fireEvent.click(screen.getByText("Codex", { selector: "span" }));
    expect(screen.queryByText("Sign-in required")).toBeNull();
  });

  // Task 10: `needs-auth` and `not-installed` are different states with
  // different affordances. An agent stuck on needs-auth is INSTALLED and
  // AVAILABLE — `provider.available` is true — so it must never grow the
  // install chip Task 10 adds for `not-installed` rows; its remedy is
  // selecting it, which the tests above already pin.
  it("never shows an Install chip for a needs-auth (installed, available) agent", () => {
    readiness = NEEDS_AUTH;
    renderSelector();
    fireEvent.click(screen.getByText("Codex", { selector: "span" }));
    expect(screen.queryByRole("button", { name: /install|retry/i })).toBeNull();
  });
});
