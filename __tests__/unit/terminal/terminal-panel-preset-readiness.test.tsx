// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * The panel's own "New terminal" launches the SELECTED CLI preset, exactly like
 * the sidebar "+". When that preset's agent is not ready it must open the
 * agent's setup on the Agents page instead of typing a command the shell can't
 * run — the dropdown gate alone never covered the preset already selected.
 */

const push = vi.fn();
const mutateAsync = vi.fn();
const setActiveTerminalId = vi.fn();
let terminalCliId = "claude-code";
let statuses: Record<string, { ready: boolean }> | undefined;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/queries/agent-status", () => ({
  useAllAgentStatus: () => ({ data: statuses }),
}));
vi.mock("@/lib/queries/terminals", () => ({
  useTerminalSessions: () => ({ data: [], isLoading: false, isFetching: false }),
  useCreateTerminal: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("@/hooks/terminal/use-terminal-file-drop", () => ({
  useTerminalFileDrop: () => ({ handleDrop: vi.fn(), isUploading: false }),
}));
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    activeTerminalId: null,
    setActiveTerminalId,
    terminalCliId,
    onboardingDemoOffer: false,
    setOnboardingDemoOffer: vi.fn(),
  }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/terminal/terminal-view", () => ({ default: () => <div /> }));

const { default: TerminalPanel } = await import("@/components/terminal/terminal-panel");

function clickNewTerminal() {
  render(<TerminalPanel />);
  fireEvent.click(screen.getByRole("button", { name: /new terminal/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mutateAsync.mockResolvedValue({ id: "t-new" });
  terminalCliId = "claude-code";
  statuses = undefined;
});

describe("TerminalPanel — New terminal under a not-ready CLI preset", () => {
  it("opens the selected preset's setup and creates no terminal when its agent is not ready", async () => {
    statuses = { "claude-code": { ready: false }, codex: { ready: true } };
    clickNewTerminal();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/agents?tab=agents&agent=claude-code"));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(setActiveTerminalId).not.toHaveBeenCalled();
  });

  it("creates the terminal when the selected preset's agent is ready", async () => {
    terminalCliId = "codex";
    statuses = { "claude-code": { ready: false }, codex: { ready: true } };
    clickNewTerminal();

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith("codex"));
    await waitFor(() => expect(setActiveTerminalId).toHaveBeenCalledWith("t-new"));
    expect(push).not.toHaveBeenCalled();
  });

  it("never gates the plain Shell", async () => {
    terminalCliId = "shell";
    statuses = {};
    clickNewTerminal();

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith("shell"));
    expect(push).not.toHaveBeenCalled();
  });

  it("gates nothing while the agent status is still loading", async () => {
    statuses = undefined;
    clickNewTerminal();

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith("claude-code"));
    expect(push).not.toHaveBeenCalled();
  });
});
