// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ProviderInfo } from "@/lib/editor-state-context";

/**
 * An unavailable agent must be shown DISABLED WITH ITS REASON, not omitted.
 *
 * Claude Code's ACP adapter is installed at runtime (~212MB — it can't be
 * bundled, see lib/agents/runtime-install.ts), so on a first boot the DEFAULT
 * agent is legitimately unavailable for minutes. The selector used to render
 * `agentProviders.filter(p => p.available)`, so during that window Claude Code
 * simply vanished and the only explanation went to ~/.libi/logs/libi.log.
 */

const selectAgent = vi.fn();
let providers: ProviderInfo[] = [];

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    agentProviders: providers,
    activeProviderId: "codex",
    isAgentConnecting: false,
    selectAgent,
    refreshAgentProviders: vi.fn(),
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
  fireEvent.click(screen.getByText("Codex", { selector: "span" }));
}

describe("AgentSelector — unavailable agents", () => {
  beforeEach(() => {
    selectAgent.mockReset();
    providers = [];
  });

  it("shows a still-installing agent (disabled, with the reason) instead of hiding it", () => {
    providers = [
      claude({
        unavailableReason: {
          code: "installing",
          message: "Installing Claude Code support (~212 MB) — this can take a few minutes.",
        },
      }),
      CODEX,
    ];

    openMenu();

    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText(/Installing Claude Code support/)).toBeInTheDocument();
  });

  it("renders the row disabled and does not select it on click", () => {
    providers = [
      claude({
        unavailableReason: { code: "install_failed", message: "…restart libi to retry." },
      }),
      CODEX,
    ];

    openMenu();

    const row = screen.getByText("Claude Code").closest("[data-slot='dropdown-menu-item']")!;
    expect(row).toHaveAttribute("data-disabled");
    fireEvent.click(row);
    expect(selectAgent).not.toHaveBeenCalled();
  });

  it("distinguishes the three states by their message", () => {
    for (const [code, message] of [
      ["installing", "Installing Claude Code support (~212 MB) — this can take a few minutes."],
      ["install_failed", "Claude Code support failed to install — restart libi to retry."],
      ["not_installed", "Claude Code support isn't installed yet — restart libi to install it."],
    ] as const) {
      providers = [claude({ unavailableReason: { code, message } }), CODEX];
      const { unmount } = render(<AgentSelector />);
      fireEvent.click(screen.getAllByText("Codex", { selector: "span" })[0]);
      expect(screen.getByText(message)).toBeInTheDocument();
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
