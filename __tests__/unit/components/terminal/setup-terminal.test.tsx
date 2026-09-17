// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { SetupTerminalEntry } from "@/components/agents-page/setup-terminal-host";

/**
 * The setup terminal's frame: Claude Code's sign-in runs its full-screen
 * interface, so that one terminal is taller than every other setup command's.
 */

let entry: SetupTerminalEntry;
vi.mock("@/components/terminal/terminal-view", () => ({ default: () => <div data-testid="terminal-view" /> }));
vi.mock("@/components/agents-page/setup-terminal-host", () => ({
  useSetupTerminalHost: () => ({ terminals: { agents: entry }, close: vi.fn(), markExited: vi.fn(), markGone: vi.fn() }),
}));

import { SetupTerminal } from "@/components/terminal/setup-terminal";

function withEntry(over: Partial<SetupTerminalEntry>): SetupTerminalEntry {
  return { id: "t1", action: "install", command: "cmd", exited: false, exitCode: null, gone: false, ...over };
}

describe("SetupTerminal frame height", () => {
  it("is tall for Claude Code's sign-in", () => {
    entry = withEntry({ action: "sign-in", anchor: "claude-code" });
    render(<SetupTerminal surface="agents" />);
    expect(screen.getByTestId("setup-terminal-frame")).toHaveClass("h-[32rem]");
  });

  it("keeps the regular height for Codex's sign-in and for every other command", () => {
    for (const over of [
      { action: "sign-in", anchor: "codex" },
      { action: "install", anchor: "claude-code" },
      { action: "connect-libi", anchor: "claude-code" },
    ] as const) {
      entry = withEntry(over);
      const { unmount } = render(<SetupTerminal surface="agents" />);
      expect(screen.getByTestId("setup-terminal-frame")).toHaveClass("h-64");
      unmount();
    }
  });
});

describe("SetupTerminal explanation", () => {
  it("shows what the waiting command does under the prompt line", () => {
    entry = withEntry({ action: "connect-libi", anchor: "codex", explanation: "Adds Libi MCP to Codex's config." });
    render(<SetupTerminal surface="agents" />);
    expect(screen.getByText("Read the command, then press Enter in the terminal to run it.")).toBeInTheDocument();
    expect(screen.getByTestId("setup-terminal-explanation")).toHaveTextContent("Adds Libi MCP to Codex's config.");
  });

  it("shows no explanation line when the opener gave none", () => {
    entry = withEntry({ action: "install" });
    render(<SetupTerminal surface="agents" />);
    expect(screen.queryByTestId("setup-terminal-explanation")).toBeNull();
  });
});

describe("SetupTerminal script links", () => {
  it("links every script the waiting command runs, each opening its text in a new tab", () => {
    entry = withEntry({
      action: "provider-replace",
      anchor: "fal:codex",
      explanation: "Replaces your current fal.ai entry in Codex.",
      scripts: [
        { name: "replace-provider.sh", url: "/api/agents/setup-scripts/replace-provider.sh" },
        { name: "add-provider.sh", url: "/api/agents/setup-scripts/add-provider.sh" },
      ],
    });
    render(<SetupTerminal surface="agents" />);
    expect(screen.getByTestId("setup-terminal-explanation")).toHaveTextContent("Replaces your current fal.ai entry in Codex.");
    const links = within(screen.getByTestId("setup-terminal-scripts")).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["View replace-provider.sh", "View add-provider.sh"]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/api/agents/setup-scripts/replace-provider.sh",
      "/api/agents/setup-scripts/add-provider.sh",
    ]);
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
      expect(link.className).toContain("cursor-pointer");
    }
  });

  it("shows no script links for a command that runs no script", () => {
    for (const over of [{ scripts: [] }, {}]) {
      entry = withEntry({ action: "connect-libi", explanation: "Adds Libi MCP.", ...over });
      const { unmount } = render(<SetupTerminal surface="agents" />);
      expect(screen.queryByTestId("setup-terminal-scripts")).toBeNull();
      expect(screen.queryByRole("link")).toBeNull();
      unmount();
    }
  });
});
