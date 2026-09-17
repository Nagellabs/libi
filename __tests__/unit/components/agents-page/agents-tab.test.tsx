// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AgentStatus } from "@/lib/agents/agent-status";

/**
 * The Agents tab owns which wizard is open. `?agent=` opens it for that agent at
 * its first incomplete step once the status is known — once, and never over a
 * wizard that is already open. A consumed deep link is removed from the URL,
 * because the tab unmounts on every tab switch: a param left behind would
 * re-open a closed wizard when the user came back.
 *
 * Onboarding decides what else the tab shows. A first onboarding is the wizard
 * alone, at step 1, whatever is already installed. A pick that was never taken
 * to the end brings back the rows with that agent's wizard reopened. Once the
 * wizard has been finished the tab is the rows, and a wizard only on request.
 */

import { followSearch, freshAgentsUrl } from "../../../helpers/agents-page-url";

const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => {
    followSearch(search);
    return { replace };
  },
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(search),
}));

const ready: AgentStatus = {
  agentId: "claude-code",
  cli: { path: "/u/claude", realPath: "/u/claude", version: "2.1.250", meetsMinimum: true },
  adapter: "ready",
  signIn: { confirmedAt: "2026-09-10T00:00:00.000Z", needsAuth: false },
  libiTools: { state: "connected", scope: "user" },
  ready: true,
};
let oneStatus: AgentStatus | undefined;
const oneStatusCalls = vi.fn();
vi.mock("@/lib/queries/agent-status", () => ({
  useAgentStatus: (...args: unknown[]) => {
    oneStatusCalls(...args);
    const agent = args[0] as string | null;
    return { data: agent ? oneStatus : undefined };
  },
  // Both CLIs are on the machine in every test: a first onboarding must not show them anyway.
  useAllAgentStatus: () => ({
    data: { "claude-code": { ...ready, libiTools: { state: "not-connected" } }, codex: { ...ready, agentId: "codex" } },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

type Onboarding = { wizardAgentChosenAt: string | null; wizardAgent: string | null; wizardFinished: boolean };
const FIRST: Onboarding = { wizardAgentChosenAt: null, wizardAgent: null, wizardFinished: false };
const FINISHED: Onboarding = { wizardAgentChosenAt: "2026-09-01T00:00:00.000Z", wizardAgent: "claude-code", wizardFinished: true };
const chose = (agent: string): Onboarding => ({ wizardAgentChosenAt: "2026-09-13T10:00:00.000Z", wizardAgent: agent, wizardFinished: false });
let onboarding: Onboarding | undefined;
let onboardingError = false;
const updateOnboarding = vi.fn();
vi.mock("@/lib/queries/onboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries/onboarding")>()),
  useOnboardingState: () => ({ data: onboarding, isError: onboardingError, failureCount: onboardingError ? 4 : 0 }),
  useUpdateOnboardingState: () => ({ mutate: updateOnboarding }),
}));

let hostTerminals: Partial<Record<string, { anchor?: string }>> = {};
const hostClose = vi.fn(async () => undefined);
vi.mock("@/components/agents-page/setup-terminal-host", () => ({
  useSetupTerminalHost: () => ({ terminals: hostTerminals, close: hostClose }),
}));
vi.mock("@/components/agents-page/agents-tab/wizard", () => ({
  Wizard: ({
    agent,
    step,
    onClose,
    onStep,
    onAgent,
    onFinish,
  }: {
    agent: string | null;
    step: number;
    onClose?: () => void;
    onStep: (s: number) => void;
    onAgent: (a: string) => void;
    onFinish?: () => void;
  }) => (
    <div data-testid="wizard">
      {agent ?? "-"} step {step}
      {onClose ? <button onClick={onClose}>close</button> : null}
      <button onClick={() => onStep(1)}>restart</button>
      {/* Step 1's pick, standing in for the choose step. */}
      <button onClick={() => onAgent("codex")}>choose</button>
      {onFinish ? <button onClick={onFinish}>finish</button> : null}
    </div>
  ),
}));
import { AgentsTab } from "@/components/agents-page/agents-tab/agents-tab";
import { OnboardingVisitProvider, agentsTabOnboarding } from "@/components/agents-page/agents-tab/onboarding-visit";

/** The page around the tab: the visit outlives the tab, which unmounts on a tab switch. */
function page(showTab: boolean, agent: "claude-code" | "codex" | null = null) {
  return <OnboardingVisitProvider>{showTab ? <AgentsTab agent={agent} /> : <div data-testid="other-tab" />}</OnboardingVisitProvider>;
}

beforeEach(() => {
  oneStatus = { ...ready, cli: null, ready: false };
  oneStatusCalls.mockClear();
  replace.mockClear();
  search = "";
  freshAgentsUrl();
  hostTerminals = {};
  hostClose.mockClear();
  onboarding = FINISHED;
  onboardingError = false;
  updateOnboarding.mockClear();
});

describe("AgentsTab", () => {
  it("?agent= opens the wizard at the first incomplete step; Close keeps it closed across re-renders", () => {
    const { rerender } = render(<AgentsTab agent="codex" />);
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 2");
    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByTestId("wizard")).toBeNull();
    rerender(<AgentsTab agent="codex" />);
    expect(screen.queryByTestId("wizard")).toBeNull();
  });

  it("waits for the deep-linked agent's status before opening", () => {
    oneStatus = undefined;
    const { rerender } = render(<AgentsTab agent="claude-code" />);
    expect(screen.queryByTestId("wizard")).toBeNull();
    oneStatus = { ...ready, signIn: { confirmedAt: null, needsAuth: false } };
    rerender(<AgentsTab agent="claude-code" />);
    expect(screen.getByTestId("wizard")).toHaveTextContent("claude-code step 3");
  });

  it("without ?agent= no wizard opens and no single-agent status is fetched", () => {
    render(<AgentsTab agent={null} />);
    expect(screen.queryByTestId("wizard")).toBeNull();
    // The hook disables itself for a null agent; the tab passes nothing more.
    expect(oneStatusCalls).toHaveBeenCalledWith(null);
    expect(oneStatusCalls).not.toHaveBeenCalledWith("claude-code");
    expect(replace).not.toHaveBeenCalled();
  });

  it("a status-bar row click opens the wizard for that agent; the wizard can move itself back to step 1", () => {
    render(<AgentsTab agent={null} />);
    fireEvent.click(screen.getByTestId("agent-status-open-claude-code"));
    expect(screen.getByTestId("wizard")).toHaveTextContent("claude-code step 4");
    fireEvent.click(screen.getByText("restart"));
    expect(screen.getByTestId("wizard")).toHaveTextContent("claude-code step 1");
  });

  it("a different ?agent= value opens the wizard again after an earlier one was closed", () => {
    const { rerender } = render(<AgentsTab agent="codex" />);
    fireEvent.click(screen.getByText("close"));
    rerender(<AgentsTab agent="claude-code" />);
    expect(screen.getByTestId("wizard")).toHaveTextContent("claude-code step 2");
  });

  it("a consumed deep link leaves the URL, keeping the other params; the open wizard stays open", () => {
    search = "tab=agents&agent=codex&from=sess-1";
    const { rerender } = render(<AgentsTab agent="codex" />);
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 2");
    expect(replace).toHaveBeenCalledWith("/agents?tab=agents&from=sess-1", { scroll: false });
    search = "tab=agents&from=sess-1";
    rerender(<AgentsTab agent={null} />);
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 2");
  });

  it("a closed deep-linked wizard stays closed after the tab unmounts and mounts again", () => {
    search = "tab=agents&agent=codex";
    const { rerender, unmount } = render(<AgentsTab agent="codex" />);
    expect(screen.getByTestId("wizard")).toBeInTheDocument();
    search = "tab=agents"; // what the router does with the replace above
    rerender(<AgentsTab agent={null} />);
    fireEvent.click(screen.getByText("close"));
    unmount(); // switching to another tab unmounts this panel
    render(<AgentsTab agent={null} />); // …and coming back mounts a fresh one
    expect(screen.queryByTestId("wizard")).toBeNull();
  });

  it("a deep link whose status arrives after the user opened a wizard does not replace it", () => {
    oneStatus = undefined;
    search = "agent=codex";
    const { rerender } = render(<AgentsTab agent="codex" />);
    expect(screen.queryByTestId("wizard")).toBeNull();
    fireEvent.click(screen.getByTestId("agent-status-open-claude-code"));
    expect(screen.getByTestId("wizard")).toHaveTextContent("claude-code step 4");
    oneStatus = { ...ready, agentId: "codex", cli: null, ready: false };
    rerender(<AgentsTab agent="codex" />);
    expect(screen.getByTestId("wizard")).toHaveTextContent("claude-code step 4");
    // Consumed without opening, so it leaves the URL and Close does not surface it.
    expect(replace).toHaveBeenCalledWith("/agents", { scroll: false });
    fireEvent.click(screen.getByText("close"));
    rerender(<AgentsTab agent="codex" />);
    expect(screen.queryByTestId("wizard")).toBeNull();
  });

  // Closing the setup terminal kills whatever the user submitted in it — an
  // installer, a browser sign-in, a chained reconnect — so neither moving the
  // wizard nor closing it may end the terminal. Which agent's wizard SHOWS it is
  // the wizard's job, covered by the wizard's own setup-terminal test.
  it("moving the wizard to another agent leaves the previous agent's setup terminal running", () => {
    hostTerminals = { agents: { anchor: "codex" } };
    render(<AgentsTab agent="codex" />);
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 2");
    fireEvent.click(screen.getByTestId("agent-status-open-claude-code"));
    expect(screen.getByTestId("wizard")).toHaveTextContent("claude-code step 4");
    expect(hostClose).not.toHaveBeenCalled();
  });

  it("Close leaves the wizard's setup terminal running, and the owning agent's wizard opens over it again", () => {
    hostTerminals = { agents: { anchor: "codex" } };
    render(<AgentsTab agent="codex" />);
    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByTestId("wizard")).toBeNull();
    fireEvent.click(screen.getByTestId("agent-status-open-codex"));
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex");
    expect(hostClose).not.toHaveBeenCalled();
  });

  it("a tab that mounts with no wizard open leaves the setup terminal alone, and the same agent's wizard keeps it", () => {
    hostTerminals = { agents: { anchor: "codex" } };
    render(<AgentsTab agent={null} />);
    expect(hostClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("agent-status-open-codex"));
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex");
    expect(hostClose).not.toHaveBeenCalled();
  });

  it("once the param is gone, the same deep link arriving again opens the wizard again", () => {
    const { rerender } = render(<AgentsTab agent="codex" />);
    fireEvent.click(screen.getByText("close"));
    rerender(<AgentsTab agent={null} />); // the consumed value resets with the param
    expect(screen.queryByTestId("wizard")).toBeNull();
    rerender(<AgentsTab agent="codex" />); // e.g. a chat card links here again
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 2");
  });
});

describe("AgentsTab — onboarding", () => {
  it("agentsTabOnboarding: nothing recorded is a first onboarding, a pick alone resumes, a finished wizard is done", () => {
    expect(agentsTabOnboarding(FIRST)).toBe("first");
    expect(agentsTabOnboarding(chose("codex"))).toBe("resume");
    expect(agentsTabOnboarding(FINISHED)).toBe("done");
    expect(agentsTabOnboarding({ wizardAgentChosenAt: null, wizardFinished: true })).toBe("done");
  });

  it("a first onboarding is the wizard alone, at step 1, with Claude Code and Codex both detected — no status rows, no Close", () => {
    onboarding = FIRST;
    render(<AgentsTab agent={null} />);
    expect(screen.getByTestId("wizard")).toHaveTextContent("- step 1");
    expect(screen.queryByTestId("agent-status-bar")).toBeNull();
    expect(screen.queryByTestId("agent-status-row-claude-code")).toBeNull();
    expect(screen.queryByTestId("agent-status-row-codex")).toBeNull();
    expect(screen.queryByText("close")).toBeNull();
    expect(updateOnboarding).not.toHaveBeenCalled();
  });

  it("picking an agent records it as the choice, and this visit stays wizard-only after the state catches up", () => {
    onboarding = FIRST;
    const { rerender } = render(<AgentsTab agent={null} />);
    fireEvent.click(screen.getByText("choose"));
    expect(updateOnboarding).toHaveBeenCalledWith({ wizardAgentChosen: "codex" });
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 2");
    onboarding = chose("codex"); // the refetch after the write
    rerender(<AgentsTab agent={null} />);
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 2");
    expect(screen.queryByTestId("agent-status-bar")).toBeNull();
    expect(screen.queryByText("close")).toBeNull();
  });

  it("switching tabs in the same visit comes back wizard-only, at the chosen agent's first incomplete step", () => {
    onboarding = FIRST;
    const { rerender } = render(page(true));
    fireEvent.click(screen.getByText("choose"));
    onboarding = chose("codex");
    rerender(page(false));
    oneStatus = undefined;
    rerender(page(true));
    // The chosen agent's status is not known yet: the skeleton, never the rows.
    expect(screen.getByTestId("agents-tab-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-status-bar")).toBeNull();
    oneStatus = { ...ready, agentId: "codex", signIn: { confirmedAt: null, needsAuth: false } };
    rerender(page(true));
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 3");
    expect(screen.queryByTestId("agent-status-bar")).toBeNull();
  });

  it("a revisit with an agent chosen but the wizard unfinished shows the rows and reopens that agent's wizard at its first incomplete step", () => {
    onboarding = chose("claude-code");
    oneStatus = { ...ready, signIn: { confirmedAt: null, needsAuth: false } };
    render(<AgentsTab agent={null} />);
    expect(screen.getByTestId("agent-status-row-claude-code")).toBeInTheDocument();
    expect(screen.getByTestId("agent-status-row-codex")).toBeInTheDocument();
    expect(screen.getByTestId("wizard")).toHaveTextContent("claude-code step 3");
    expect(oneStatusCalls).toHaveBeenCalledWith("claude-code");
    // Not a first onboarding any more: the wizard can be closed to the rows.
    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByTestId("wizard")).toBeNull();
    expect(screen.getByTestId("agent-status-row-claude-code")).toBeInTheDocument();
  });

  it("a revisit whose chosen agent has nothing left before Open chat shows the rows alone and records the wizard as finished, and a tab switch keeps it that way", () => {
    onboarding = chose("claude-code");
    // Installed, its support downloaded, signed in and connected: only Open chat is left.
    oneStatus = ready;
    const { rerender } = render(page(true));
    expect(screen.queryByTestId("wizard")).toBeNull();
    expect(screen.getByTestId("agent-status-row-claude-code")).toBeInTheDocument();
    expect(updateOnboarding).toHaveBeenCalledWith({ wizardFinished: true });
    expect(updateOnboarding).toHaveBeenCalledTimes(1);
    onboarding = { ...chose("claude-code"), wizardFinished: true }; // the server's answer to that save
    rerender(page(false));
    rerender(page(true));
    expect(screen.queryByTestId("wizard")).toBeNull();
    expect(screen.getByTestId("agent-status-row-claude-code")).toBeInTheDocument();
    expect(updateOnboarding).toHaveBeenCalledTimes(1);
  });

  it("a revisit whose chosen agent still has a step before Open chat reopens the wizard at that step and records nothing", () => {
    onboarding = chose("claude-code");
    oneStatus = { ...ready, adapter: "missing", ready: false };
    const { rerender } = render(<AgentsTab agent={null} />);
    expect(screen.getByTestId("wizard")).toHaveTextContent("claude-code step 2");
    // The download finishing while the wizard is open moves nothing by itself.
    oneStatus = ready;
    rerender(<AgentsTab agent={null} />);
    expect(screen.getByTestId("wizard")).toHaveTextContent("claude-code step 2");
    expect(updateOnboarding).not.toHaveBeenCalled();
  });

  it("a revisit waits for the chosen agent's status before reopening its wizard, showing the rows meanwhile", () => {
    onboarding = chose("codex");
    oneStatus = undefined;
    const { rerender } = render(<AgentsTab agent={null} />);
    expect(screen.getByTestId("agent-status-row-codex")).toBeInTheDocument();
    expect(screen.queryByTestId("wizard")).toBeNull();
    oneStatus = { ...ready, agentId: "codex", cli: null, ready: false };
    rerender(<AgentsTab agent={null} />);
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 2");
  });

  it("the reopened wizard, once closed, stays closed when the tab comes back in the same visit; the next visit reopens it", () => {
    onboarding = chose("codex");
    const { rerender, unmount } = render(page(true));
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 2");
    fireEvent.click(screen.getByText("close"));
    rerender(page(false));
    rerender(page(true));
    expect(screen.queryByTestId("wizard")).toBeNull();
    expect(screen.getByTestId("agent-status-row-codex")).toBeInTheDocument();
    unmount(); // leaving the page, or a reload
    render(page(true));
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 2");
  });

  it("once the wizard has been finished: the rows, and a wizard only when the user opens one", () => {
    onboarding = FINISHED;
    render(<AgentsTab agent={null} />);
    expect(screen.getByTestId("agent-status-row-claude-code")).toBeInTheDocument();
    expect(screen.queryByTestId("wizard")).toBeNull();
    expect(oneStatusCalls).not.toHaveBeenCalledWith("claude-code");
    fireEvent.click(screen.getByTestId("agent-status-open-codex"));
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 4");
    expect(screen.getByText("close")).toBeInTheDocument();
  });

  it("while the onboarding state loads the tab is its skeleton — never status rows, never a wizard", () => {
    onboarding = undefined;
    const { rerender } = render(<AgentsTab agent={null} />);
    expect(screen.getByTestId("agents-tab-skeleton")).toBeInTheDocument();
    expect(screen.getAllByTestId("agent-status-row-skeleton")).toHaveLength(2);
    expect(screen.queryByTestId("agent-status-bar")).toBeNull();
    expect(screen.queryByTestId("agent-status-row-claude-code")).toBeNull();
    expect(screen.queryByTestId("wizard")).toBeNull();
    onboarding = FIRST;
    rerender(<AgentsTab agent={null} />);
    expect(screen.queryByTestId("agents-tab-skeleton")).toBeNull();
    expect(screen.getByTestId("wizard")).toHaveTextContent("- step 1");
    expect(screen.queryByTestId("agent-status-bar")).toBeNull();
  });

  it("an onboarding state that can't be read falls back to the rows", () => {
    onboarding = undefined;
    onboardingError = true;
    render(<AgentsTab agent={null} />);
    expect(screen.getByTestId("agent-status-row-claude-code")).toBeInTheDocument();
    expect(screen.queryByTestId("wizard")).toBeNull();
  });

  it("?agent= on a first onboarding preselects that agent, records it as the choice and shows no rows", () => {
    onboarding = FIRST;
    search = "tab=agents&agent=codex";
    render(<AgentsTab agent="codex" />);
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 2");
    expect(updateOnboarding).toHaveBeenCalledWith({ wizardAgentChosen: "codex" });
    expect(screen.queryByTestId("agent-status-bar")).toBeNull();
    expect(replace).toHaveBeenCalledWith("/agents?tab=agents", { scroll: false });
  });

  it("?agent= on a first onboarding shows the skeleton, not rows, until that agent's status is known", () => {
    onboarding = FIRST;
    oneStatus = undefined;
    const { rerender } = render(<AgentsTab agent="claude-code" />);
    expect(screen.getByTestId("agents-tab-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-status-bar")).toBeNull();
    expect(updateOnboarding).not.toHaveBeenCalled();
    oneStatus = ready;
    rerender(<AgentsTab agent="claude-code" />);
    expect(screen.getByTestId("wizard")).toHaveTextContent("claude-code step 4");
    expect(updateOnboarding).toHaveBeenCalledWith({ wizardAgentChosen: "claude-code" });
  });

  it("reaching the wizard's end is recorded while onboarding is unfinished", () => {
    onboarding = chose("codex");
    render(<AgentsTab agent={null} />);
    fireEvent.click(screen.getByText("finish"));
    expect(updateOnboarding).toHaveBeenCalledWith({ wizardFinished: true });
  });

  it("after the wizard was finished, neither a pick nor reaching the end records anything", () => {
    onboarding = FINISHED;
    render(<AgentsTab agent={null} />);
    fireEvent.click(screen.getByTestId("agent-status-open-claude-code"));
    fireEvent.click(screen.getByText("restart"));
    fireEvent.click(screen.getByText("choose"));
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 2");
    expect(screen.queryByText("finish")).toBeNull();
    expect(updateOnboarding).not.toHaveBeenCalled();
  });
});
