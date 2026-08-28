// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";

/**
 * Task 9: the onboarding panel renders the SHARED `AgentSetupCard` (Task 8)
 * per `listAgentSetups()` (Task 4) instead of its own local `AgentCard` +
 * hardcoded `AGENTS` array. Terminal is not an ACP agent
 * (`getAgentSetup("terminal")` returns null by design) and keeps its own
 * row, unchanged, after the "or" divider.
 */

const selectAgent = vi.fn();
const refreshAgentProviders = vi.fn();
const setRightRegionMode = vi.fn();
// Defaults to a successful create — the overwhelmingly common case, and the
// one every unrelated test wants to be uninteresting.
const createSessionWithResult = vi.fn(async () => ({
  sessionId: "s-1",
  error: null as string | null,
}));
const startInstallMutate = vi.fn();
const cancelInstallMutate = vi.fn();

let agentProviders: Array<{ id: string; name: string; available: boolean }> = [];
let activeProviderId: string | null = null;
let isAgentConnecting = false;
let installJob: { job: unknown } = { job: null };
let startInstall: { mutate: typeof startInstallMutate; isPending?: boolean; error?: Error | null } = {
  mutate: startInstallMutate,
};
// Mutable per-test so a test can hand back an OBSERVED needs-auth readiness
// (with a real `remedy.command`) without every other test having to know
// about it — default mirrors "nothing attempted yet this process".
let readinessFor: (agentId: string) => AgentReadiness = () => ({ state: "unknown" });

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    activeProviderId,
    isAgentConnecting,
    selectAgent,
    agentProviders,
    refreshAgentProviders,
    setRightRegionMode,
    sessionList: {
      readinessFor: (agentId: string) => readinessFor(agentId),
      createSessionWithResult,
    },
  }),
}));

// `useRunRemedyInTerminal` reaches for the app router and the terminal
// mutation, neither of which exists in this render. It has its own tests; here
// we only care THAT the card asks it to open a terminal, and with what.
const runRemedyInTerminal = vi.fn(() => Promise.resolve());
vi.mock("@/hooks/agents/use-run-remedy-in-terminal", () => ({
  useRunRemedyInTerminal: () => runRemedyInTerminal,
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m), info: vi.fn() } }));

const trackEvent = vi.fn();
vi.mock("@/lib/analytics/client", () => ({
  trackEvent: (name: string, params?: Record<string, unknown>) => trackEvent(name, params),
}));

vi.mock("@/lib/queries/agent-setup", async () => {
  const actual = await vi.importActual<typeof import("@/lib/queries/agent-setup")>(
    "@/lib/queries/agent-setup",
  );
  return {
    ...actual,
    useAgentInstall: () => ({ data: installJob }),
    useStartAgentInstall: () => startInstall,
    useCancelAgentInstall: () => ({ mutate: cancelInstallMutate }),
  };
});

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient();
  const result = render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  return {
    ...result,
    // `result.rerender` replaces the WHOLE tree, provider included — re-wrap
    // so a rerender doesn't strip the QueryClient out from under the panel.
    rerender: (next: React.ReactElement) =>
      result.rerender(<QueryClientProvider client={qc}>{next}</QueryClientProvider>),
  };
}

const PANEL_PATH = join(process.cwd(), "components/onboarding/onboarding-panel.tsx");

beforeEach(() => {
  vi.clearAllMocks();
  agentProviders = [];
  activeProviderId = null;
  isAgentConnecting = false;
  installJob = { job: null };
  startInstall = { mutate: startInstallMutate, isPending: false, error: null };
  readinessFor = () => ({ state: "unknown" });
  createSessionWithResult.mockResolvedValue({ sessionId: "s-1", error: null });
  // `clearAllMocks` clears CALLS, not implementations — without this a test
  // that hands back an observed needs-auth leaks it into every test after it.
  selectAgent.mockResolvedValue(undefined);
  global.fetch = vi.fn(async () =>
    new Response(
      JSON.stringify({
        agents: [
          { id: "claude-code", installed: false },
          { id: "codex", installed: false },
        ],
      }),
      { status: 200 },
    ),
  ) as never;
});

describe("OnboardingPanel — renders the shared setup card", () => {
  it("keeps the heading and subhead copy", async () => {
    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    wrap(<OnboardingPanel />);
    expect(screen.getByText("Connect a coding agent")).toBeInTheDocument();
    expect(screen.getByText(/last step/i)).toBeInTheDocument();
    expect(
      screen.getByText(/you type what you want\. the agent builds it/i),
    ).toBeInTheDocument();
    // Says what happens after, so the screen is not a step into the unknown.
    // Names the one conditional step after this screen, and says where the
    // key lives — so it is not a surprise later, and not a privacy question.
    expect(
      screen.getByText(/for AI asset generation \(video\/image\/music\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/the key stays local/i)).toBeInTheDocument();
  });

  it("renders one AgentSetupCard per listAgentSetups() entry, on the onboarding surface", async () => {
    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    const { listAgentSetups } = await import("@/lib/agents/setup/registry");
    const { container } = wrap(<OnboardingPanel />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/agent/detect"));

    const cards = container.querySelectorAll('[data-slot="agent-setup-card"]');
    expect(cards.length).toBe(listAgentSetups().length);
    for (const card of Array.from(cards)) {
      expect(card.getAttribute("data-surface")).toBe("onboarding");
    }
  });

  it("does NOT render a setup card for Terminal — it is not an ACP agent", async () => {
    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    const { getAgentSetup } = await import("@/lib/agents/setup/registry");
    expect(getAgentSetup("terminal")).toBeNull();

    const { container } = wrap(<OnboardingPanel />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    expect(screen.getByText("Terminal")).toBeInTheDocument();
    // Terminal's row must not itself be (or sit inside) a setup card.
    const terminalRow = screen.getByText("Terminal").closest('[data-slot="agent-setup-card"]');
    expect(terminalRow).toBeNull();
    // And the card count stays exactly the ACP agent count (no 3rd card).
    const { listAgentSetups } = await import("@/lib/agents/setup/registry");
    expect(container.querySelectorAll('[data-slot="agent-setup-card"]').length).toBe(
      listAgentSetups().length,
    );
  });

  it("puts an uninstalled Claude Code in install mode, and Codex (no install step) in sign-in mode", async () => {
    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    wrap(<OnboardingPanel />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: /install claude code/i })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /sign in to codex/i })).toBeInTheDocument();
  });

  it("switches Claude Code to sign-in mode once detection reports it installed", async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          agents: [
            { id: "claude-code", installed: true },
            { id: "codex", installed: false },
          ],
        }),
        { status: 200 },
      ),
    ) as never;
    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    wrap(<OnboardingPanel />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /sign in to claude code/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /install claude code/i })).toBeNull();
  });

  it("shows a busy, disabled action button — not a silently inert one — while selectAgent() is in flight", async () => {
    // The old local card disabled Connect and showed a spinner while
    // selectAgent() ran. AgentSetupCard has no spinner (this repo's
    // convention: skeletons, never spinners) but must still say something is
    // happening, or a slow first connect looks inert and invites a
    // double-click.
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          agents: [
            { id: "claude-code", installed: true },
            { id: "codex", installed: false },
          ],
        }),
        { status: 200 },
      ),
    ) as never;
    isAgentConnecting = true;
    activeProviderId = "claude-code";

    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    wrap(<OnboardingPanel />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const busyButton = await screen.findByRole("button", { name: /connecting/i });
    expect(busyButton).toBeDisabled();
    // Codex isn't the agent being connected — it stays untouched.
    expect(screen.getByRole("button", { name: /sign in to codex/i })).not.toBeDisabled();
  });

  it("falls back to detection's resolved command when no readiness exists yet", async () => {
    // The state this screen is ALWAYS in on first paint: no agent selected, so
    // the client holds readiness for nobody, so `readinessFor` says "unknown"
    // for everything. Before /api/agent/detect carried the command, that meant
    // Copy handed over the readable short form — which fails wherever the
    // agent is not on PATH, i.e. every machine, since libi puts nothing there.
    readinessFor = () => ({ state: "unknown" });
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          agents: [
            {
              id: "claude-code",
              installed: true,
              signInRemedy: { label: "Sign in to Claude Code", command: "'/tree/claude'", detail: "" },
            },
            {
              id: "codex",
              installed: true,
              signInRemedy: {
                label: "Sign in to Codex",
                command: "'/tree/node_modules/@openai/codex/bin/codex' login",
                detail: "",
              },
            },
          ],
        }),
        { status: 200 },
      ),
    ) as never;

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    const { container } = wrap(<OnboardingPanel />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /sign in to claude code/i }),
      ).toBeInTheDocument(),
    );

    const codexCard = Array.from(
      container.querySelectorAll('[data-slot="agent-setup-card"]'),
    ).find((c) => within(c as HTMLElement).queryByText("Codex")) as HTMLElement;
    fireEvent.click(within(codexCard).getByRole("button", { name: /copy/i }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "'/tree/node_modules/@openai/codex/bin/codex' login",
      ),
    );
  });

  it("opens a terminal instead of connecting — Claude's handshake cannot tell us", async () => {
    // Claude Code answers `session/new` happily with NO credentials (confirmed
    // on the Windows QA box: repeated standby_create_done on a machine that
    // was never signed in). So "connect and see what happens" — which is how
    // Codex's auth state becomes knowable — can never detect Claude's. That is
    // why the sign-in button must NOT be a connect: detection resolves the
    // real command without a handshake, and this button runs that.
    const remedy = { label: "Sign in to Claude Code", command: "'/tree/claude'", detail: "" };
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          agents: [{ id: "claude-code", installed: true, signInRemedy: remedy }],
        }),
        { status: 200 },
      ),
    ) as never;

    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    wrap(<OnboardingPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /^sign in to claude code$/i }));

    await waitFor(() =>
      expect(runRemedyInTerminal).toHaveBeenCalledWith(remedy, "claude-code", "onboarding"),
    );
    expect(selectAgent).not.toHaveBeenCalled();
  });

  it("leads with Start chat, which connects AND opens a session in libi's own chat", async () => {
    // Most developer machines with a coding-agent CLI on them are already
    // signed into it, and libi cannot tell which — so the majority case is
    // the primary button. Connecting alone is not enough: it leaves the user
    // in the editor with an empty session list, still one click short of the
    // chat the screen promised.
    const remedy = { label: "Sign in to Codex", command: "'/tree/codex' login", detail: "" };
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ agents: [{ id: "codex", installed: true, signInRemedy: remedy }] }),
        { status: 200 },
      ),
    ) as never;

    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    wrap(<OnboardingPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /^start chat$/i }));

    await waitFor(() => expect(selectAgent).toHaveBeenCalledWith("codex"));
    await waitFor(() => expect(createSessionWithResult).toHaveBeenCalled());
    await waitFor(() => expect(setRightRegionMode).toHaveBeenCalledWith("editor"));
    expect(runRemedyInTerminal).not.toHaveBeenCalled();
  });

  it("sends Start chat on to the sign-in terminal when the connect OBSERVES needs-auth", async () => {
    // Codex rejects at `session/new`, so this is the one agent whose auth
    // state connecting can actually establish. Having established it, opening
    // a chat that cannot answer would be worse than the detour.
    const remedy = { label: "Sign in to Codex", command: "'/tree/codex' login", detail: "" };
    selectAgent.mockResolvedValue({
      state: "needs-auth",
      agentId: "codex",
      message: "Authentication required",
      remedy,
    });
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ agents: [{ id: "codex", installed: true }] }), {
        status: 200,
      }),
    ) as never;

    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    wrap(<OnboardingPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /^start chat$/i }));

    await waitFor(() =>
      expect(runRemedyInTerminal).toHaveBeenCalledWith(remedy, "codex", "onboarding"),
    );
    // No chat is opened on a machine we have just been told cannot chat.
    expect(createSessionWithResult).not.toHaveBeenCalled();
  });

  it("stays on the screen and says why when the session cannot be created", async () => {
    // `createError` is rendered by the SIDEBAR, which is not what the user is
    // looking at during the takeover — so without this the click is silent
    // and the screen simply does not move.
    createSessionWithResult.mockResolvedValue({
      sessionId: null,
      error: "Authentication required",
    });
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ agents: [{ id: "codex", installed: true }] }), {
        status: 200,
      }),
    ) as never;

    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    wrap(<OnboardingPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /^start chat$/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Authentication required"));
    expect(setRightRegionMode).not.toHaveBeenCalled();
  });

  it("keeps signing in one click away, next to Start chat", async () => {
    // The minority who are NOT signed in must not have to fail first to find
    // the sign-in — it is a real button beside the primary, not a link.
    const remedy = { label: "Sign in to Codex", command: "'/tree/codex' login", detail: "" };
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          agents: [
            // Claude Code is here only as a detect-has-landed signal: it
            // starts in INSTALL mode and only becomes a sign-in once
            // detection reports it installed, so waiting for its sign-in
            // button proves the response — and with it Codex's remedy — has
            // arrived. Clicking Codex before that lands on the documented
            // no-remedy fallback (connect and see), which is a different
            // behaviour than the one under test.
            { id: "claude-code", installed: true },
            { id: "codex", installed: true, signInRemedy: remedy },
          ],
        }),
        { status: 200 },
      ),
    ) as never;

    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    wrap(<OnboardingPanel />);

    await screen.findByRole("button", { name: /^sign in to claude code$/i });
    fireEvent.click(screen.getByRole("button", { name: /^sign in to codex$/i }));

    await waitFor(() =>
      expect(runRemedyInTerminal).toHaveBeenCalledWith(remedy, "codex", "onboarding"),
    );
    expect(selectAgent).not.toHaveBeenCalled();
  });

  it("hands the Copy button the OBSERVED remedy command, not the readable short form", async () => {
    // libi puts nothing on PATH, so the short form ("codex") fails on exactly
    // the machines this feature exists for. Once sessionList.readinessFor
    // reports an observed needs-auth with a resolved remedy.command, the
    // panel must thread that real command through to AgentSetupCard's
    // resolvedCommand prop — proven here by what actually lands on the
    // clipboard, not by re-reading the prop wiring.
    readinessFor = (agentId) =>
      agentId === "codex"
        ? {
            state: "needs-auth",
            agentId: "codex",
            message: "Codex needs sign-in",
            remedy: {
              label: "Sign in to Codex",
              command: "/very/long/resolved/node_modules/path/to/codex login",
              detail: "Runs the Codex engine libi already ships.",
            },
          }
        : { state: "unknown" };

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    const { container } = wrap(<OnboardingPanel />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /sign in to codex/i })).toBeInTheDocument(),
    );

    const cards = container.querySelectorAll('[data-slot="agent-setup-card"]');
    // Registry order is [claude-code, codex] (lib/agents/setup/registry.ts).
    const codexCard = within(cards[1] as HTMLElement);
    fireEvent.click(codexCard.getByRole("button", { name: /copy/i }));

    expect(writeText).toHaveBeenCalledWith(
      "/very/long/resolved/node_modules/path/to/codex login",
    );
  });

  it("describes a cancelled install as cancelled, not as an error, and offers Retry", async () => {
    // A cancelled job renders in the same failed-style block as a real
    // failure (right — a plain "Install" button after a cancel would
    // silently replay the same terminal row) but the copy must say what
    // actually happened, not read like an error. Genuine failures keep
    // naming their real cause from job.error.
    installJob = {
      job: {
        id: "job-1",
        status: "cancelled",
        progressDone: 0,
        progressTotal: 0,
        error: null,
      },
    };
    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    wrap(<OnboardingPanel />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument());
    expect(screen.getByText(/cancelled/i)).toBeInTheDocument();
    expect(screen.queryByText(/did not finish/i)).toBeNull();
  });

  it("no string from the deleted local AGENTS array survives in the file", () => {
    const source = readFileSync(PANEL_PATH, "utf8");
    // The hardcoded install hints this stage deletes, not moves — that copy
    // now lives only in lib/agents/setup/registry.ts.
    expect(source).not.toContain("npm i -g @anthropic-ai/claude-code, then run");
    expect(source).not.toContain("npm i -g @openai/codex, then run");
    expect(source).not.toContain("Anthropic's coding agent. Best results with libi.");
    expect(source).not.toContain("OpenAI's coding agent. A strong alternative.");
    expect(source).not.toContain("const AGENTS");
    expect(source).not.toContain("AgentDef[]");
    // The local two-state AgentCard component this stage replaces.
    expect(source).not.toMatch(/function AgentCard\(/);
    // It must render the shared card instead.
    expect(source).toContain("AgentSetupCard");
    expect(source).toContain("listAgentSetups");
  });
});

/**
 * Finding 1b: all three setup surfaces derive their card state from the same
 * job, and the completion handling now lives once, in
 * `useAgentSetupCardState`. These cover what onboarding does with it —
 * previously untested on every surface.
 */
describe("OnboardingPanel — the completed install", () => {
  it("pushes a completed install into the lists this panel reads", async () => {
    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    const { rerender } = wrap(<OnboardingPanel />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /install claude code/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /install claude code/i }));
    expect(startInstallMutate).toHaveBeenCalledWith("claude-code");

    installJob = {
      job: { id: "job-1", status: "running", progressDone: 10, progressTotal: 250, error: null },
    };
    rerender(<OnboardingPanel />);
    installJob = {
      job: { id: "job-1", status: "completed", progressDone: 250, progressTotal: 250, error: null },
    };
    rerender(<OnboardingPanel />);

    // `agentProviders` is not React Query — nothing invalidates it, so the
    // panel has to be told, or the agent stays greyed out until reload.
    await waitFor(() => expect(refreshAgentProviders).toHaveBeenCalled());
  });

  it("says something is happening during the Install POST round-trip", async () => {
    startInstall = { mutate: startInstallMutate, isPending: true, error: null };
    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    wrap(<OnboardingPanel />);

    const button = await screen.findByRole("button", { name: /starting/i });
    expect(button).toBeDisabled();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("shows a failed Install POST instead of silently doing nothing", async () => {
    startInstall = {
      mutate: startInstallMutate,
      isPending: false,
      error: new Error("Install failed to start (400)"),
    };
    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    wrap(<OnboardingPanel />);

    expect(await screen.findByText(/install failed to start \(400\)/i)).toBeInTheDocument();
  });
});

describe("OnboardingPanel — funnel step 5 still fires from this surface", () => {
  it("emits agent_setup_started once, with surface=onboarding", async () => {
    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    wrap(<OnboardingPanel />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /install claude code/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /install claude code/i }));

    const started = trackEvent.mock.calls.filter(([n]) => n === "agent_setup_started");
    expect(started).toHaveLength(1);
    expect(started[0][1]).toEqual({
      agent: "claude-code",
      action: "install",
      surface: "onboarding",
    });
  });

  it("emits sign_in for the agent libi already ships", async () => {
    const { OnboardingPanel } = await import("@/components/onboarding/onboarding-panel");
    wrap(<OnboardingPanel />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /sign in to codex/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /sign in to codex/i }));

    expect(trackEvent).toHaveBeenCalledWith("agent_setup_started", {
      agent: "codex",
      action: "sign_in",
      surface: "onboarding",
    });
    expect(selectAgent).toHaveBeenCalledWith("codex");
  });
});
