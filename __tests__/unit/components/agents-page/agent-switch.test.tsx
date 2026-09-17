// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  AgentSwitch,
  AgentSwitchPanel,
  OtherAgentTerminalNotice,
  setupTerminalState,
} from "@/components/agents-page/agent-switch";

/**
 * The Claude Code | Codex switch the setup tabs share: presentational, so each
 * tab supplies its label, the selection, its hints and its test-id prefix.
 */

function renderSwitch(onValueChange = vi.fn()) {
  render(
    <AgentSwitch label="Set up for" value="claude-code" onValueChange={onValueChange} hints={{ codex: "3 ready" }} testIdPrefix="global-setup">
      <AgentSwitchPanel value="claude-code">
        <p>content</p>
      </AgentSwitchPanel>
    </AgentSwitch>,
  );
}

describe("AgentSwitch", () => {
  it("names its test ids by the prefix, shows a hint only where one is given, and reports a pick", () => {
    const onValueChange = vi.fn();
    renderSwitch(onValueChange);
    const tablist = screen.getByRole("tablist", { name: "Set up for" });
    expect(tablist).toHaveAttribute("data-testid", "global-setup-agent-switch");
    expect(screen.getByTestId("global-setup-agent-option-claude-code").textContent).toBe("Claude Code");
    expect(screen.getByTestId("global-setup-agent-option-codex").textContent).toBe("Codex 3 ready");
    expect(screen.getByTestId("global-setup-agent-option-claude-code")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("content");
    fireEvent.click(screen.getByTestId("global-setup-agent-option-codex"));
    expect(onValueChange).toHaveBeenCalledWith("codex");
  });

  it("keeps an option's name and hint apart when read out", () => {
    renderSwitch();
    expect(screen.getByRole("tab", { name: "Codex 3 ready" })).toBe(screen.getByTestId("global-setup-agent-option-codex"));
    expect(screen.getByRole("tab", { name: "Claude Code" })).toBe(screen.getByTestId("global-setup-agent-option-claude-code"));
  });

  it("styles the selected option in the primary tint with an outline, the other as muted text with a hover background, and keeps a focus ring", () => {
    renderSwitch();
    for (const agentId of ["claude-code", "codex"]) {
      const option = screen.getByTestId(`global-setup-agent-option-${agentId}`);
      expect(option).toHaveClass(
        "cursor-pointer",
        "data-active:bg-primary/15",
        "data-active:border-primary/50",
        "data-active:font-medium",
        "data-active:text-foreground",
        "text-foreground/70",
        "not-data-active:hover:bg-foreground/10",
        "focus-visible:ring-[3px]",
      );
      // The primitive's grey selected pill is replaced, not layered under the tint.
      expect(option).not.toHaveClass("data-active:bg-background");
    }
  });
});

describe("OtherAgentTerminalNotice", () => {
  it.each([
    ["live", "Codex has a setup command open."],
    ["exited", "Codex's setup command finished."],
    ["gone", "Codex's setup terminal was closed."],
  ] as const)("while the terminal is %s it says %j, with a button to show it", (state, text) => {
    const onShow = vi.fn();
    render(<OtherAgentTerminalNotice agentId="codex" state={state} onShow={onShow} testId="global-setup-other-agent-terminal" />);
    const notice = screen.getByTestId("global-setup-other-agent-terminal");
    expect(notice.querySelector("span")?.textContent).toBe(text);
    const show = screen.getByRole("button", { name: "Show Codex" });
    expect(show).toHaveClass("cursor-pointer");
    fireEvent.click(show);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("reads a terminal's state the way the terminal does: a finished command says finished even once the server closed it", () => {
    expect(setupTerminalState({ exited: false, gone: false })).toBe("live");
    expect(setupTerminalState({ exited: true, gone: false })).toBe("exited");
    expect(setupTerminalState({ exited: false, gone: true })).toBe("gone");
    expect(setupTerminalState({ exited: true, gone: true })).toBe("exited");
  });
});
