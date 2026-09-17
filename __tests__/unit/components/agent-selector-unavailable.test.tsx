// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ProviderInfo } from "@/lib/editor-state-context";

/**
 * An unavailable agent must be shown DISABLED WITH ITS REASON, not omitted.
 *
 * The selector used to render `agentProviders.filter(p => p.available)`, so an
 * agent that wasn't set up simply vanished and the only explanation went to
 * ~/.libi/logs/libi.log. It later grew Install / Retry chips wired to an
 * install job right inside the dropdown. Setup now lives on the Agents page:
 * a not-ready row is disabled, says the server's one-line reason, and is
 * followed by a "Set up in Agents" link to that agent's setup.
 */

const selectAgent = vi.fn();
const reloadAgentProviders = vi.fn();

let providers: ProviderInfo[] = [];

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    agentProviders: providers,
    activeProviderId: "codex",
    isAgentConnecting: false,
    selectAgent,
    reloadAgentProviders,
    sessionList: {
      readiness: { state: "unknown" },
      readinessFor: () => ({ state: "unknown" }),
    },
  }),
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

function openMenu() {
  render(<AgentSelector />);
  // The trigger label is the (hardcoded, in this file's mock) active agent.
  fireEvent.click(screen.getAllByText("Codex", { selector: "span" })[0]);
}

function rowFor(name: string): HTMLElement {
  const row = screen
    .getAllByText(name, { selector: "span" })
    .map((el) => el.closest("[data-slot='dropdown-menu-item']"))
    .find((el): el is HTMLElement => el != null);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function setUpLinks(): HTMLAnchorElement[] {
  return screen
    .queryAllByText("Set up in Agents")
    .map((el) => el.closest("a"))
    .filter((el): el is HTMLAnchorElement => el != null);
}

describe("AgentSelector — unavailable agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providers = [];
  });

  it("shows a still-installing agent (disabled, with the reason) instead of hiding it", () => {
    providers = [
      claude({
        unavailableReason: {
          code: "installing",
          message: "Downloading Claude Code support (56 MB) — this can take a few minutes.",
        },
      }),
      CODEX,
    ];

    openMenu();

    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText(/Downloading Claude Code support/)).toBeInTheDocument();
    // No Install / Retry / Cancel control inside the menu — the only way on is
    // the row's Set up in Agents link; the Agents page shows the install.
    expect(screen.queryByRole("button", { name: /install|retry|cancel/i })).toBeNull();
    expect(rowFor("Claude Code")).toHaveAttribute("data-disabled");
  });

  it("a not-ready row is disabled, carries the reason, and its Set up in Agents link targets the agent", () => {
    providers = [
      claude({
        unavailableReason: {
          code: "install_failed",
          message: "Claude Code was found at /opt/claude but won't run — open Agents.",
        },
      }),
      CODEX,
    ];

    openMenu();

    expect(rowFor("Claude Code")).toHaveAttribute("data-disabled");
    expect(
      screen.getByText("Claude Code was found at /opt/claude but won't run — open Agents."),
    ).toBeInTheDocument();
    const links = setUpLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/agents?tab=agents&agent=claude-code");
    expect(links[0].className).toContain("cursor-pointer");
    expect(screen.queryByRole("button", { name: /install|retry/i })).toBeNull();
  });

  it("clicking a not-ready row does not select it", () => {
    providers = [
      claude({
        unavailableReason: {
          code: "not_installed",
          message: "Claude Code isn't set up yet — open Agents to install it.",
        },
      }),
      CODEX,
    ];

    openMenu();

    fireEvent.click(rowFor("Claude Code"));
    expect(selectAgent).not.toHaveBeenCalled();
  });

  it("gives Codex the same disabled row and a link to Codex's setup", () => {
    providers = [
      claude({ available: true }),
      {
        ...CODEX,
        available: false,
        unavailableReason: {
          code: "not_installed",
          message: "Codex isn't set up yet — open Agents to install it.",
        },
      },
    ];

    openMenu();

    expect(rowFor("Codex")).toHaveAttribute("data-disabled");
    expect(setUpLinks().map((a) => a.getAttribute("href"))).toEqual([
      "/agents?tab=agents&agent=codex",
    ]);
  });

  it("distinguishes the three states, always showing the reason and never the retired 'restart libi' copy", () => {
    for (const [code, message] of [
      ["installing", "Downloading Claude Code support (56 MB) — this can take a few minutes."],
      ["install_failed", "Claude Code was found at /opt/claude but won't run — open Agents."],
      ["not_installed", "Claude Code isn't set up yet — open Agents to install it."],
    ] as const) {
      providers = [claude({ unavailableReason: { code, message } }), CODEX];
      const { unmount } = render(<AgentSelector />);
      fireEvent.click(screen.getAllByText("Codex", { selector: "span" })[0]);
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(setUpLinks()).toHaveLength(1);
      expect(document.body.textContent).not.toContain("restart libi");
      unmount();
    }
  });

  it("an available agent stays clickable and carries no reason text or setup link", () => {
    providers = [claude({ available: true }), CODEX];

    openMenu();

    const row = rowFor("Claude Code");
    expect(row).not.toHaveAttribute("data-disabled");
    expect(setUpLinks()).toHaveLength(0);
    fireEvent.click(row);
    expect(selectAgent).toHaveBeenCalledWith("claude-code");
  });
});

describe("the menu's footer", () => {
  beforeEach(() => {
    reloadAgentProviders.mockClear();
    providers = [claude({ available: true }), CODEX];
  });

  it("links to the Agents tab to manage agents, and offers no re-detect action", () => {
    openMenu();
    expect(screen.queryByText(/re-detect agents/i)).toBeNull();
    const manage = screen.getByText("Manage agents").closest("a");
    expect(manage).toHaveAttribute("href", "/agents?tab=agents");
  });

  it("reads the agent list again every time the menu opens", () => {
    openMenu();
    expect(reloadAgentProviders).toHaveBeenCalledTimes(1);
  });
});
