// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * The "Launch CLI" dropdown used to offer every preset unconditionally and hang
 * an `npm i -g …` install hint on a tooltip nobody saw. A preset whose agent is
 * not set up now says so in the menu and sends the user to that agent's setup
 * on the Agents page instead of selecting a command the shell can't run.
 */

const setTerminalCliId = vi.fn();
let statuses: Record<string, { ready: boolean }> | undefined;
let terminalCliId = "shell";

// A plain anchor that keeps the click in the page: a not-ready preset is a link,
// and jsdom cannot navigate, so following a real href only prints noise.
vi.mock("next/link", async () => {
  const { forwardRef } = await import("react");
  return {
    default: forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(
      function Link({ href, onClick, ...rest }, ref) {
        return (
          <a
            ref={ref}
            href={href}
            {...rest}
            onClick={(e) => {
              onClick?.(e);
              e.preventDefault();
            }}
          />
        );
      },
    ),
  };
});
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ terminalCliId, setTerminalCliId }),
}));
vi.mock("@/lib/queries/agent-status", () => ({
  useAllAgentStatus: () => ({ data: statuses }),
}));

const { default: CliPresetSelector } = await import("@/components/terminal/cli-preset-selector");

function openMenu() {
  render(<CliPresetSelector />);
  // The trigger shows the selected preset's label.
  fireEvent.click(screen.getByText("Shell", { selector: "span" }));
}

/** A menu row — a plain item, or the link item a not-ready preset becomes. */
function item(label: string): HTMLElement {
  const el = screen
    .getAllByText(label)
    .map((node) =>
      node.closest("[data-slot='dropdown-menu-item'], [data-slot='dropdown-menu-link-item']"),
    )
    .find((node): node is HTMLElement => node != null);
  if (!el) throw new Error(`no menu item for ${label}`);
  return el;
}

describe("CliPresetSelector — agent readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statuses = undefined;
    terminalCliId = "shell";
  });

  it("renders a preset whose agent is not ready as a link to its setup, with Set up in Agents in place of its command", () => {
    statuses = { "claude-code": { ready: true }, codex: { ready: false } };
    openMenu();

    const codex = item("Codex");
    expect(codex).toHaveAttribute("data-not-ready");
    // It navigates, so it is a link — not an item that claims to be disabled.
    expect(codex.tagName).toBe("A");
    expect(codex).toHaveAttribute("href", "/agents?tab=agents&agent=codex");
    expect(codex).not.toHaveAttribute("aria-disabled");
    expect(codex.className).toContain("cursor-pointer");
    expect(codex).toHaveTextContent("Set up in Agents");
    expect(codex).not.toHaveTextContent(/^Codexcodex$/);
    expect(codex.querySelector(".font-mono")).toBeNull();

    const claude = item("Claude Code");
    expect(claude).not.toHaveAttribute("data-not-ready");
    expect(claude).toHaveTextContent("claude");
    expect(claude).not.toHaveTextContent("Set up in Agents");
  });

  it("clicking a not-ready preset follows its setup link instead of selecting it", () => {
    statuses = { "claude-code": { ready: true }, codex: { ready: false } };
    openMenu();

    const codex = item("Codex");
    expect(codex).toHaveAttribute("href", "/agents?tab=agents&agent=codex");
    fireEvent.click(codex);
    expect(setTerminalCliId).not.toHaveBeenCalled();
  });

  it("a ready preset still selects", () => {
    statuses = { "claude-code": { ready: true }, codex: { ready: true } };
    openMenu();

    fireEvent.click(item("Claude Code"));
    expect(setTerminalCliId).toHaveBeenCalledWith("claude-code");
  });

  it("keeps every preset enabled while the status is still loading — never a flash of not-ready", () => {
    statuses = undefined;
    openMenu();

    expect(screen.queryByText("Set up in Agents")).toBeNull();
    for (const label of ["Claude Code", "Codex"]) {
      expect(item(label)).not.toHaveAttribute("data-not-ready");
    }
  });

  it("never gates the plain Shell, and treats an agent missing from the response as not ready", () => {
    statuses = {};
    openMenu();

    const shell = screen
      .getAllByText("Shell")
      .map((node) => node.closest("[data-slot='dropdown-menu-item']"))
      .find((node): node is HTMLElement => node != null)!;
    expect(shell).not.toHaveAttribute("data-not-ready");
    expect(item("Claude Code")).toHaveAttribute("data-not-ready");
    expect(item("Codex")).toHaveAttribute("data-not-ready");
  });

  it("says Set up in Agents on the trigger when the SELECTED preset's agent is not ready, linking to its setup", () => {
    terminalCliId = "claude-code";
    statuses = { "claude-code": { ready: false }, codex: { ready: true } };
    render(<CliPresetSelector />);

    // Without opening the menu: the default preset is what "+" launches.
    const link = screen.getByRole("link", { name: /set up in agents/i });
    expect(link).toHaveAttribute("href", "/agents?tab=agents&agent=claude-code");
    expect(link.className).toContain("cursor-pointer");
    expect(screen.getByText("Claude Code", { selector: "span" })).toBeInTheDocument();
  });

  it("keeps the trigger plain for a ready selection, a Shell selection, and while loading", () => {
    for (const [cli, s] of [
      ["claude-code", { "claude-code": { ready: true }, codex: { ready: false } }],
      ["shell", {}],
      ["claude-code", undefined],
    ] as const) {
      terminalCliId = cli;
      statuses = s;
      const { unmount } = render(<CliPresetSelector />);
      expect(screen.queryByRole("link", { name: /set up in agents/i })).toBeNull();
      unmount();
    }
  });

  it("carries no install-hint tooltip", () => {
    statuses = { "claude-code": { ready: false }, codex: { ready: false } };
    openMenu();
    for (const label of ["Claude Code", "Codex"]) {
      expect(item(label).getAttribute("title") ?? "").not.toMatch(/npm/);
    }
  });
});
