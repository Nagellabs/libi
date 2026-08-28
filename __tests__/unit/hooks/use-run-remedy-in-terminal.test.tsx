// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * Windows, 2026-08-25: pressing "Sign in to Claude Code" switched the agent to
 * Terminal and spawned a Shell with the login command in it — and left the
 * view on "Connect a coding agent". The terminal was running behind a screen
 * still asking the user to connect an agent.
 *
 * It had worked by ACCIDENT: a page-level effect left the takeover whenever
 * `activeProviderId` changed, and `selectAgent("terminal")` changes it. That
 * effect was removed (it could not tell a user's choice from the value merely
 * populating at mount), and this path was never re-checked afterwards.
 */

const selectAgent = vi.fn(async () => null);
const setActiveTerminalId = vi.fn();
const setRightRegionMode = vi.fn();
const mutateAsync = vi.fn(async () => ({ id: "term-1" }));

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ selectAgent, setActiveTerminalId, setRightRegionMode }),
}));
vi.mock("@/lib/queries/terminals", () => ({
  useCreateTerminal: () => ({ mutateAsync }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/editor",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/analytics/client", () => ({ trackEvent: vi.fn() }));

const REMEDY = {
  label: "Sign in to Claude Code",
  command: "'/opt/libi/bin/claude'",
  detail: "Opens Claude Code's own sign-in flow in a terminal.",
};

beforeEach(() => vi.clearAllMocks());

describe("useRunRemedyInTerminal", () => {
  it("leaves the connect takeover, so the terminal is not opened behind it", async () => {
    const { useRunRemedyInTerminal } = await import(
      "@/hooks/agents/use-run-remedy-in-terminal"
    );
    const { result } = renderHook(() => useRunRemedyInTerminal());
    await act(async () => {
      await result.current(REMEDY, "claude-code", "onboarding");
    });
    expect(setRightRegionMode).toHaveBeenCalledWith("editor");
  });

  it("still does the three things it already did", async () => {
    const { useRunRemedyInTerminal } = await import(
      "@/hooks/agents/use-run-remedy-in-terminal"
    );
    const { result } = renderHook(() => useRunRemedyInTerminal());
    await act(async () => {
      await result.current(REMEDY, "claude-code", "onboarding");
    });
    expect(selectAgent).toHaveBeenCalledWith("terminal");
    // The command goes in at SPAWN, not typed afterwards — see the hook's own
    // note on why every client-side delivery raced the mount.
    expect(mutateAsync).toHaveBeenCalledWith({
      cliId: "shell",
      initialInput: REMEDY.command,
    });
    expect(setActiveTerminalId).toHaveBeenCalledWith("term-1");
  });

  it("does not close the takeover when the terminal could not be created", async () => {
    // A failed spawn leaves the user where they were, with the error. Closing
    // the screen would strand them on an editor with nothing to act on.
    mutateAsync.mockRejectedValueOnce(new Error("no pty"));
    const { useRunRemedyInTerminal } = await import(
      "@/hooks/agents/use-run-remedy-in-terminal"
    );
    const { result } = renderHook(() => useRunRemedyInTerminal());
    await act(async () => {
      await result.current(REMEDY, "claude-code", "onboarding");
    });
    expect(setRightRegionMode).not.toHaveBeenCalled();
  });
});
