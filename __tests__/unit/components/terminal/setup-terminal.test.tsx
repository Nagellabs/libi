// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { SetupTerminalEntry } from "@/components/agents-page/setup-terminal-host";

/**
 * The setup terminal's frame: Claude Code's sign-in runs its full-screen
 * interface, so that one terminal is taller than every other setup command's.
 */

let entry: SetupTerminalEntry;
// Like xterm, the view keeps its keyboard input in a helper textarea; focusing the terminal focuses that.
type ViewProps = { onSubmit?: () => void; keyFilter?: (ev: KeyboardEvent) => boolean; onOutput?: () => void };
const viewProps: ViewProps[] = [];
vi.mock("@/components/terminal/terminal-view", () => ({
  default: (props: ViewProps) => {
    viewProps.push(props);
    return (
      <div data-testid="terminal-view">
        <textarea className="xterm-helper-textarea" aria-label="Terminal input" />
      </div>
    );
  },
}));
const markSubmitted = vi.fn();
vi.mock("@/components/agents-page/setup-terminal-host", () => ({
  useSetupTerminalHost: () => ({ terminals: { agents: entry }, close: vi.fn(), markExited: vi.fn(), markGone: vi.fn(), markSubmitted }),
}));

import { SETUP_ENTER_GUARD_MS, SetupTerminal, createEnterGuard } from "@/components/terminal/setup-terminal";

function withEntry(over: Partial<SetupTerminalEntry>): SetupTerminalEntry {
  return { id: "t1", action: "install", command: "cmd", exited: false, exitCode: null, gone: false, submitted: false, ...over };
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

/**
 * Owner-reported 2026-09-25: Sign in / Remove typed the command into a terminal that opened BELOW the provider card,
 * off screen and unfocused, so "nothing happened". A newly opened terminal is scrolled into view and focused, so Enter
 * runs the command at once. Every setup surface renders this one component.
 */
describe("SetupTerminal brings a new terminal to the user", () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
    markSubmitted.mockClear();
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("scrolls the terminal into view and focuses its input when it opens", () => {
    entry = withEntry({ id: "t-new", action: "provider-sign-in", anchor: "elevenlabs:claude-code" });
    render(<SetupTerminal surface="agents" />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(screen.getByTestId("setup-terminal-agents"));
    expect(document.activeElement).toBe(screen.getByLabelText("Terminal input"));
  });

  it("does it once per terminal, and not for one that already ran or is gone", () => {
    entry = withEntry({ id: "t-a" });
    const { rerender, unmount } = render(<SetupTerminal surface="agents" />);
    rerender(<SetupTerminal surface="agents" />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    unmount();
    for (const over of [{ id: "t-b", exited: true, exitCode: 0 }, { id: "t-c", gone: true }, { id: "t-d", submitted: true }]) {
      entry = withEntry(over);
      const r = render(<SetupTerminal surface="agents" />);
      r.unmount();
    }
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("says to press Enter until the user has, then that the command is running", () => {
    entry = withEntry({ id: "t-e" });
    const { rerender } = render(<SetupTerminal surface="agents" />);
    expect(screen.getByText("Read the command, then press Enter in the terminal to run it.")).toBeInTheDocument();
    viewProps.at(-1)!.onSubmit!();
    expect(markSubmitted).toHaveBeenCalledWith("agents", "t-e");
    entry = withEntry({ id: "t-e", submitted: true });
    rerender(<SetupTerminal surface="agents" />);
    expect(screen.getByText("Running. Follow what it asks in the terminal.")).toBeInTheDocument();
  });
});

// The terminal takes the keyboard as it opens, with the command already typed at its prompt: an Enter that was
// still on its way (the one that clicked the button from the keyboard, or a held key repeating) must not run it.
describe("SetupTerminal Enter guard", () => {
  const enter = (repeat = false) => ({ key: "Enter", repeat });

  it("drops an Enter within 500 ms of the terminal taking focus, and takes one after", () => {
    let t = 1_000;
    const guard = createEnterGuard(() => t);
    expect(guard.accepts(enter())).toBe(false);
    t += SETUP_ENTER_GUARD_MS - 1;
    expect(guard.accepts(enter())).toBe(false);
    t += 1;
    expect(guard.accepts(enter())).toBe(true);
  });

  it("output reaching the screen (the command being typed at the prompt) starts the 500 ms again, until the command is submitted", () => {
    let t = 1_000;
    const guard = createEnterGuard(() => t);
    t += 2_000;
    guard.arm();
    expect(guard.accepts(enter())).toBe(false);
    t += SETUP_ENTER_GUARD_MS;
    expect(guard.accepts(enter())).toBe(true);
    guard.markSubmitted();
    // After the command ran, output never holds an Enter back: the script may be asking for something.
    guard.arm();
    expect(guard.accepts(enter())).toBe(true);
  });

  it("a repeating Enter (a key held down) is dropped always; every other key passes at once", () => {
    let t = 1_000;
    const guard = createEnterGuard(() => t);
    expect(guard.accepts({ key: "a", repeat: false })).toBe(true);
    expect(guard.accepts({ key: "c", repeat: true })).toBe(true);
    t += 5_000;
    expect(guard.accepts(enter(true))).toBe(false);
    guard.markSubmitted();
    expect(guard.accepts(enter(true))).toBe(false);
    expect(guard.accepts(enter())).toBe(true);
  });

  it("the setup terminal hands the guard to its view: an Enter right after it opens is dropped, a new terminal is guarded afresh", () => {
    let t = 10_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => t);
    try {
      entry = withEntry({ id: "t-guard", action: "provider-add", anchor: "elevenlabs:claude-code" });
      const { rerender } = render(<SetupTerminal surface="agents" />);
      const view = () => viewProps.at(-1)!;
      const key = (k: string, repeat = false) => view().keyFilter!({ key: k, repeat } as KeyboardEvent);
      expect(key("Enter")).toBe(false);
      t += SETUP_ENTER_GUARD_MS;
      expect(key("Enter")).toBe(true);
      // The command lands at the prompt: guarded again.
      view().onOutput!();
      expect(key("Enter")).toBe(false);
      t += SETUP_ENTER_GUARD_MS;
      expect(key("Enter")).toBe(true);
      view().onSubmit!();
      expect(markSubmitted).toHaveBeenCalledWith("agents", "t-guard");
      view().onOutput!();
      expect(key("Enter")).toBe(true);
      expect(key("Enter", true)).toBe(false);

      // The next command opens a new terminal: its first Enter is held back again.
      entry = withEntry({ id: "t-guard-2", action: "provider-add", anchor: "elevenlabs:claude-code" });
      rerender(<SetupTerminal surface="agents" />);
      expect(key("Enter")).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("a terminal whose command was already submitted (the view remounted after a tab switch) takes an Enter at once", () => {
    const clock = vi.spyOn(performance, "now").mockImplementation(() => 10_000);
    try {
      // e.g. pasting the redirect URL `mcp login` asks for, then Enter, right as its prompt prints.
      entry = withEntry({ id: "t-remount", action: "provider-add", anchor: "elevenlabs:claude-code", submitted: true });
      render(<SetupTerminal surface="agents" />);
      const view = viewProps.at(-1)!;
      view.onOutput!();
      expect(view.keyFilter!({ key: "Enter", repeat: false } as KeyboardEvent)).toBe(true);
      expect(view.keyFilter!({ key: "Enter", repeat: true } as KeyboardEvent)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });
});
