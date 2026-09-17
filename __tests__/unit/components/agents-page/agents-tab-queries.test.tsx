// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentStatus } from "@/lib/agents/agent-status";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import type { OnboardingState } from "@/lib/queries/onboarding";
import { followSearch, freshAgentsUrl } from "../../../helpers/agents-page-url";

/**
 * The Agents tab against real React Query reads, retries included — the app sets
 * none of its own, so a failing read is retried three times over about seven
 * seconds. `agents-tab.test.tsx` covers the tab's decisions with the reads
 * stubbed; this file covers what those reads look like while they fail.
 *
 * A read that fails once must not hold the tab on its skeleton through the
 * retries, just as it doesn't hold the editor (`first-launch-gate.test.tsx`):
 * the retries go on quietly, and a late answer can't change the visit.
 */

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
vi.mock("@/components/agents-page/setup-terminal-host", () => ({
  useSetupTerminalHost: () => ({ terminals: {}, close: async () => undefined }),
}));
vi.mock("@/components/agents-page/agents-tab/wizard", () => ({
  Wizard: ({ agent, step }: { agent: string | null; step: number }) => (
    <div data-testid="wizard">
      {agent ?? "-"} step {step}
    </div>
  ),
}));

import { AgentsTab } from "@/components/agents-page/agents-tab/agents-tab";
import { OnboardingVisitProvider } from "@/components/agents-page/agents-tab/onboarding-visit";
import { agentStatusKeys } from "@/lib/queries/agent-status";
import { onboardingKeys } from "@/lib/queries/onboarding";

const ready: AgentStatus = {
  agentId: "claude-code",
  cli: { path: "/u/claude", realPath: "/u/claude", version: "2.1.250", meetsMinimum: true },
  adapter: "ready",
  signIn: { confirmedAt: "2026-09-10T00:00:00.000Z", needsAuth: false },
  libiTools: { state: "connected", scope: "user" },
  ready: true,
};
const codexReady: AgentStatus = { ...ready, agentId: "codex" };

const FIRST: OnboardingState = {
  needsPersona: false,
  persona: "developer",
  needsOnboarding: true,
  agentEverConnected: false,
  demoOffered: false,
  wizardAgentChosenAt: null,
  wizardAgent: null,
  wizardFinishedAt: null,
  wizardFinished: false,
};
const FINISHED: OnboardingState = {
  ...FIRST,
  wizardAgentChosenAt: "2026-09-01T00:00:00.000Z",
  wizardAgent: "claude-code",
  wizardFinishedAt: "2026-09-01T00:05:00.000Z",
  wizardFinished: true,
};
const chose = (agent: SetupAgentId): OnboardingState => ({
  ...FIRST,
  wizardAgentChosenAt: "2026-09-13T10:00:00.000Z",
  wizardAgent: agent,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A read whose first request fails and whose retry waits until the test answers it. */
function failsOnceThenWaits() {
  let calls = 0;
  let answerRetry: (res: Response) => void = () => {};
  return {
    route: (): Promise<Response> => {
      calls += 1;
      if (calls === 1) return Promise.resolve(new Response("{}", { status: 500 }));
      return new Promise<Response>((resolve) => {
        answerRetry = resolve;
      });
    },
    calls: () => calls,
    answer: (res: Response) => answerRetry(res),
  };
}

function stubFetch(routes: { state: () => Promise<Response>; oneStatus?: () => Promise<Response> }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/onboarding/state" && init?.method === "PUT") {
      const update = JSON.parse(String(init.body)) as { wizardAgentChosen?: SetupAgentId };
      return json(update.wizardAgentChosen ? chose(update.wizardAgentChosen) : FINISHED);
    }
    if (url === "/api/onboarding/state") return routes.state();
    if (url === "/api/agents/status") return json({ agents: { "claude-code": ready, codex: codexReady } });
    if (url.startsWith("/api/agents/status?agent=") && routes.oneStatus) return routes.oneStatus();
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The Agents page around the tab, with React Query's own retries, shortened. */
function renderPage(agent: SetupAgentId | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 10 }, mutations: { retryDelay: 10 } } });
  render(
    <QueryClientProvider client={qc}>
      <OnboardingVisitProvider>
        <AgentsTab agent={agent} />
      </OnboardingVisitProvider>
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  replace.mockClear();
  search = "";
  freshAgentsUrl();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentsTab — reads that fail", () => {
  it("an onboarding state request that fails shows the rows at once rather than after the retries, and a late answer doesn't turn the visit into an onboarding", async () => {
    const state = failsOnceThenWaits();
    stubFetch({ state: state.route });
    const qc = renderPage();

    // The retry has not answered, so the query is still pending — and the rows are already up.
    expect(await screen.findByTestId("agent-status-row-claude-code")).toBeInTheDocument();
    expect(screen.queryByTestId("agents-tab-skeleton")).toBeNull();
    await waitFor(() => expect(state.calls()).toBe(2));

    await act(async () => {
      state.answer(json(FIRST));
    });
    await waitFor(() => expect(qc.getQueryData(onboardingKeys.state)).toEqual(FIRST));
    expect(screen.getByTestId("agent-status-row-claude-code")).toBeInTheDocument();
    expect(screen.queryByTestId("wizard")).toBeNull();
  });

  it("a first onboarding's ?agent= link whose status request fails opens that agent's wizard at once rather than after the retries, and the late status moves nothing", async () => {
    search = "tab=agents&agent=codex";
    const status = failsOnceThenWaits();
    const fetchMock = stubFetch({ state: async () => json(FIRST), oneStatus: status.route });
    const qc = renderPage("codex");

    expect(await screen.findByTestId("wizard")).toHaveTextContent("codex step 2");
    expect(screen.queryByTestId("agent-status-bar")).toBeNull();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/onboarding/state", expect.objectContaining({ method: "PUT" })),
    );
    await waitFor(() => expect(status.calls()).toBe(2));

    await act(async () => {
      status.answer(json({ agents: { codex: { ...codexReady, signIn: { confirmedAt: null, needsAuth: false } } } }));
    });
    await waitFor(() => expect(qc.getQueryState(agentStatusKeys.one("codex"))?.status).toBe("success"));
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 2");
  });

  it("a revisit whose chosen agent's status request fails reopens that agent's wizard beside the rows at once rather than after the retries", async () => {
    const status = failsOnceThenWaits();
    stubFetch({ state: async () => json(chose("codex")), oneStatus: status.route });
    renderPage();

    expect(await screen.findByTestId("wizard")).toHaveTextContent("codex step 2");
    expect(screen.getByTestId("agent-status-row-codex")).toBeInTheDocument();
    // The tab's OWN read stops once it has decided, so it waits on no retry of its
    // own — but this doesn't mean the product stops retrying that status: the real
    // Wizard (mocked here) reads the same key and keeps polling it every 3s
    // (hooks/agents/use-agent-status.ts), which keeps an observer on the query and
    // its retries going. `status.calls()` below counts only this tab's reads.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByTestId("wizard")).toHaveTextContent("codex step 2");
    expect(status.calls()).toBe(1);
  });
});

describe("AgentsTab — the page's visit", () => {
  it("a tab on the Agents page uses the page's visit and starts none of its own", async () => {
    stubFetch({ state: async () => json(FINISHED) });
    const qc = renderPage();
    await screen.findByTestId("agent-status-row-claude-code");
    // Two readers of the onboarding state: the page's visit, and the tab itself.
    // A visit of the tab's own would be a third.
    expect(qc.getQueryCache().find({ queryKey: onboardingKeys.state })?.getObserversCount()).toBe(2);
  });

  it("a tab rendered without the page still gets a visit of its own", async () => {
    stubFetch({ state: async () => json(FIRST) });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AgentsTab agent={null} />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("wizard")).toHaveTextContent("- step 1");
    expect(screen.queryByTestId("agent-status-bar")).toBeNull();
  });
});
