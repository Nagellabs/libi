// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProviderInfo } from "@/lib/editor-state-context";

/**
 * An unavailable agent must be shown DISABLED WITH ITS REASON, not omitted.
 *
 * Claude Code's ACP adapter is installed at runtime (~212MB — it can't be
 * bundled, see lib/agents/runtime-install.ts), so on a first boot the DEFAULT
 * agent is legitimately unavailable for minutes. The selector used to render
 * `agentProviders.filter(p => p.available)`, so during that window Claude Code
 * simply vanished and the only explanation went to ~/.libi/logs/libi.log.
 *
 * Task 10 removes the SECOND dead end this uncovered: once the adapter finish
 * (or fails to) install, the row used to render a disabled sentence —
 * "Claude Code support failed to install — restart libi to retry." — with
 * nothing to press. Claude Code declares an install step
 * (lib/agents/setup/registry.ts), so `install_failed` / `not_installed` now
 * render a real Install (or Retry) chip wired to the same `agent_install` job
 * the connect-agent card drives. `installing` (the automatic boot-time
 * install already running) is unaffected — there is nothing new to start.
 */

const selectAgent = vi.fn();
const refreshAgentProviders = vi.fn();
const startInstallMutate = vi.fn();
const cancelInstallMutate = vi.fn();

let providers: ProviderInfo[] = [];
// Keyed by agentId so a test can give one agent a real job while another
// stays idle — mirrors onboarding-panel.test.tsx's `installJob`.
let installJob: { job: unknown } = { job: null };

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    agentProviders: providers,
    activeProviderId: "codex",
    isAgentConnecting: false,
    selectAgent,
    setRightRegionMode: vi.fn(),
    refreshAgentProviders,
    sessionList: {
      readiness: { state: "unknown" },
      readinessFor: () => ({ state: "unknown" }),
    },
  }),
}));

vi.mock("@/lib/queries/agent-setup", async () => {
  const actual = await vi.importActual<typeof import("@/lib/queries/agent-setup")>(
    "@/lib/queries/agent-setup",
  );
  return {
    ...actual,
    useAgentInstall: () => ({ data: installJob }),
    useStartAgentInstall: () => ({ mutate: startInstallMutate }),
    useCancelAgentInstall: () => ({ mutate: cancelInstallMutate }),
  };
});

const trackEvent = vi.fn();

// `useRunRemedyInTerminal` reaches for the app router and the terminal
// mutation, neither of which exists in this render. It has its own tests; here
// we only care THAT the card asks it to open a terminal, and with what.
const runRemedyInTerminal = vi.fn(() => Promise.resolve());
vi.mock("@/hooks/agents/use-run-remedy-in-terminal", () => ({
  useRunRemedyInTerminal: () => runRemedyInTerminal,
}));

vi.mock("@/lib/analytics/client", () => ({
  trackEvent: (name: string, params?: Record<string, unknown>) => trackEvent(name, params),
}));

const { default: AgentSelector } = await import("@/components/sessions/agent-selector");

function claude(overrides: Partial<ProviderInfo>): ProviderInfo {
  return {
    id: "claude-code",
    name: "Claude Code",
    available: false,
    capabilities: { canListSessions: true },
    ...overrides,
  } as ProviderInfo;
}

const CODEX: ProviderInfo = {
  id: "codex",
  name: "Codex",
  available: true,
  capabilities: { canListSessions: false },
};

/** The selector reaches React Query through `useAgentSetupCardState` (the
 *  shared install-state derivation), so it needs a client in scope — the same
 *  provider the real app layout puts above it. `rerender` re-wraps, or it
 *  would strip the provider back out. */
function renderSelector() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>
      <AgentSelector />
    </QueryClientProvider>
  );
  const result = render(tree());
  return { ...result, rerender: () => result.rerender(tree()) };
}

function openMenu() {
  renderSelector();
  fireEvent.click(screen.getByText("Codex", { selector: "span" }));
}

describe("AgentSelector — unavailable agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providers = [];
    installJob = { job: null };
  });

  it("shows a still-installing agent (disabled, with the reason) instead of hiding it", () => {
    providers = [
      claude({
        unavailableReason: {
          code: "installing",
          message: "Installing Claude Code support (~345 MB) — this can take a few minutes.",
        },
      }),
      CODEX,
    ];

    openMenu();

    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText(/Installing Claude Code support/)).toBeInTheDocument();
    // Nothing to press while libi's own boot-time install is already running.
    expect(screen.queryByRole("button", { name: /install/i })).toBeNull();
    const row = screen.getByText("Claude Code").closest("[data-slot='dropdown-menu-item']")!;
    expect(row).toHaveAttribute("data-disabled");
  });

  it("offers an Install chip instead of the dead-end sentence when the install failed", () => {
    providers = [
      claude({
        unavailableReason: { code: "install_failed", message: "…restart libi to retry." },
      }),
      CODEX,
    ];

    openMenu();

    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.queryByText("…restart libi to retry.")).toBeNull();
    expect(document.body.textContent).not.toContain("restart libi");

    // Offering an Install chip means the row can no longer carry base-ui's
    // `disabled` (it would swallow clicks on the chip) — pin that explicitly
    // so the direction is deliberate, not an accident of the rewrite.
    const row = screen.getByText("Claude Code").closest("[data-slot='dropdown-menu-item']")!;
    expect(row).not.toHaveAttribute("data-disabled");

    const installButton = screen.getByRole("button", { name: /^install$/i });
    fireEvent.click(installButton);
    expect(startInstallMutate).toHaveBeenCalledWith("claude-code");
    // Clicking the chip must not select the (still unavailable) agent.
    expect(selectAgent).not.toHaveBeenCalled();
  });

  it("clicking the row body (not the chip) does not select an unavailable agent, and does not close the menu", () => {
    providers = [
      claude({
        unavailableReason: { code: "install_failed", message: "…restart libi to retry." },
      }),
      CODEX,
    ];

    openMenu();

    // Regression: dropping base-ui's `disabled` (needed so the nested
    // Install/Cancel buttons stay clickable) also dropped its guard around
    // the row's OWN click handler. `closeOnClick` defaults to true, so a
    // click landing on the row body — near the Install button but not on
    // it — used to close the whole dropdown, where the same click used to
    // do nothing. Missing the button by a few pixels should not cost the
    // user the menu they opened it to use.
    fireEvent.click(screen.getByText("Claude Code"));
    expect(selectAgent).not.toHaveBeenCalled();
    expect(startInstallMutate).not.toHaveBeenCalled();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^install$/i })).toBeInTheDocument();
  });

  it("shows the SAME MB progress the connect-agent card shows, from the same query, while an install runs", () => {
    installJob = {
      job: { id: "job-1", status: "running", progressDone: 40, progressTotal: 250, error: null },
    };
    providers = [
      claude({ unavailableReason: { code: "install_failed", message: "…restart libi to retry." } }),
      CODEX,
    ];

    openMenu();

    expect(screen.getByText("40 / 250 MB")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^install$/i })).toBeNull();
    const cancelButton = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelButton);
    expect(cancelInstallMutate).toHaveBeenCalledWith("claude-code");
  });

  it("offers Retry (not Install) after a failed or cancelled job", () => {
    installJob = {
      job: { id: "job-1", status: "failed", progressDone: 0, progressTotal: 0, error: "network error" },
    };
    providers = [
      claude({ unavailableReason: { code: "install_failed", message: "…restart libi to retry." } }),
      CODEX,
    ];

    openMenu();

    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^install$/i })).toBeNull();
  });

  it("pushes a completed install into agentProviders idempotently — a rerender with the same job does not refresh again", () => {
    installJob = {
      job: { id: "job-1", status: "completed", progressDone: 250, progressTotal: 250, error: null },
    };
    providers = [
      claude({ unavailableReason: { code: "install_failed", message: "…restart libi to retry." } }),
      CODEX,
    ];

    const { rerender } = renderSelector();
    fireEvent.click(screen.getByText("Codex", { selector: "span" }));
    expect(refreshAgentProviders).toHaveBeenCalledWith();
    expect(refreshAgentProviders.mock.calls.every((args) => args.length === 0)).toBe(true);
    const callsAfterFirstRender = refreshAgentProviders.mock.calls.length;

    // Re-render with the identical job (same id) — must not refresh again.
    rerender();
    expect(refreshAgentProviders.mock.calls.length).toBe(callsAfterFirstRender);
  });

  it("offers no Install chip for Codex — libi ships its engine, install is null", () => {
    providers = [
      claude({ available: true }),
      { ...CODEX, available: false, unavailableReason: { code: "install_failed", message: "reinstall libi to finish installing it." } },
    ];

    renderSelector();
    // The trigger label reflects the (hardcoded, in this file's mock)
    // activeProviderId "codex" regardless of its availability.
    fireEvent.click(screen.getByText("Codex", { selector: "span" }));

    expect(screen.getByText(/reinstall libi/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /install|retry/i })).toBeNull();
    // No install to offer means this row keeps the plain disabled-with-reason
    // disposition — unlike an install-offering row, it never grows nested
    // interactive controls, so base-ui's `disabled` guard is safe to keep.
    // (Both the trigger and the row now render a "Codex" span, so pick the
    // one that's actually inside a dropdown item.)
    const codexRow = screen
      .getAllByText("Codex", { selector: "span" })
      .map((el) => el.closest("[data-slot='dropdown-menu-item']"))
      .find((el): el is HTMLElement => el != null)!;
    expect(codexRow).toHaveAttribute("data-disabled");
  });

  it("a genuinely disabled row (installing, no chip to offer) stays disabled and does not select on click", () => {
    providers = [
      claude({
        unavailableReason: {
          code: "installing",
          message: "Installing Claude Code support (~345 MB) — this can take a few minutes.",
        },
      }),
      CODEX,
    ];

    openMenu();

    const row = screen.getByText("Claude Code").closest("[data-slot='dropdown-menu-item']")!;
    expect(row).toHaveAttribute("data-disabled");
    fireEvent.click(row);
    expect(selectAgent).not.toHaveBeenCalled();
  });

  it("distinguishes the three states, without ever rendering the retired 'restart libi' copy", () => {
    for (const [code, message] of [
      ["installing", "Installing Claude Code support (~345 MB) — this can take a few minutes."],
      ["install_failed", "Claude Code support failed to install — restart libi to retry."],
      ["not_installed", "Claude Code support isn't installed yet — restart libi to install it."],
    ] as const) {
      providers = [claude({ unavailableReason: { code, message } }), CODEX];
      const { unmount } = renderSelector();
      fireEvent.click(screen.getAllByText("Codex", { selector: "span" })[0]);
      if (code === "installing") {
        expect(screen.getByText(message)).toBeInTheDocument();
      } else {
        expect(screen.queryByText(message)).toBeNull();
        expect(screen.getByRole("button", { name: /^install$/i })).toBeInTheDocument();
      }
      expect(document.body.textContent).not.toContain("restart libi");
      unmount();
    }
  });

  it("an available agent stays clickable and carries no reason text", () => {
    providers = [claude({ available: true }), CODEX];

    openMenu();

    const row = screen.getByText("Claude Code").closest("[data-slot='dropdown-menu-item']")!;
    expect(row).not.toHaveAttribute("data-disabled");
    fireEvent.click(row);
    expect(selectAgent).toHaveBeenCalledWith("claude-code");
  });
});

/**
 * Finding 3: sidebar installs were invisible to the funnel.
 *
 * `agent_setup_started` had exactly one emit site — `AgentSetupCard` — and
 * the sidebar deliberately renders its own `InstallChip` instead (a dropdown
 * row is a genuinely different rendering, and stays one). So a sidebar
 * install fired no start event, while `agent_install_completed` fires
 * server-side in the runner regardless of which surface began the job: the
 * funnel showed completions with no matching starts, and started→completed
 * read above 100%.
 *
 * The emit now lives on the shared `useAgentSetupCardState().onAction`, which
 * all three surfaces call — so sharing the derivation closed the funnel hole
 * as a side effect rather than needing a fourth hand-placed emit.
 */
describe("AgentSelector — the sidebar reports its own installs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providers = [];
    installJob = { job: null };
  });

  it("emits agent_setup_started with surface=sidebar when the chip starts an install", () => {
    providers = [
      claude({ unavailableReason: { code: "install_failed", message: "…restart libi to retry." } }),
      CODEX,
    ];

    openMenu();
    fireEvent.click(screen.getByRole("button", { name: /^install$/i }));

    expect(startInstallMutate).toHaveBeenCalledWith("claude-code");
    expect(trackEvent).toHaveBeenCalledWith("agent_setup_started", {
      agent: "claude-code",
      action: "install",
      surface: "sidebar",
    });
  });

  it("emits it exactly once per click, not once per surface that could render", () => {
    providers = [
      claude({ unavailableReason: { code: "not_installed", message: "not installed" } }),
      CODEX,
    ];
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
    expect(trackEvent.mock.calls.filter(([n]) => n === "agent_setup_started")).toHaveLength(1);
  });
});
