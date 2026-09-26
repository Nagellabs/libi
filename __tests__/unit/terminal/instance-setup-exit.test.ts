import { describe, it, expect, vi, beforeEach } from "vitest";

const invalidateMock = vi.fn();
vi.mock("@/lib/agents/cli/resolve", () => ({ invalidateAgentCliMemo: (...a: unknown[]) => invalidateMock(...a) }));
const clearRegistrationMock = vi.fn();
vi.mock("@/lib/agents/libi-registration", () => ({ __clearLibiRegistrationMemo: (...a: unknown[]) => clearRegistrationMock(...a) }));
const clearProviderMock = vi.fn();
vi.mock("@/lib/providers/detect", () => ({ __clearProviderMemo: (...a: unknown[]) => clearProviderMock(...a) }));
const probe = vi.hoisted(() => ({ started: vi.fn(), ended: vi.fn(), endAll: vi.fn() }));
vi.mock("@/lib/providers/claude-signin-probe", () => ({
  noteClaudeLoginStarted: (...a: unknown[]) => probe.started(...a),
  noteClaudeLoginEnded: (...a: unknown[]) => probe.ended(...a),
  endClaudeLoginsOf: (...a: unknown[]) => probe.endAll(...a),
}));
const warnMock = vi.fn();
vi.mock("@/lib/logger", () => ({ serverLogger: { warn: (...a: unknown[]) => warnMock(...a), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/libi-home", () => ({ getLibiAgentDir: () => "/tmp/agent" }));
vi.mock("@/lib/terminal/pty", () => ({ realPtyFactory: vi.fn() }));
const openedMock = vi.fn();
const closedMock = vi.fn();
vi.mock("@/lib/terminal/setup-activity", () => ({
  noteSetupTerminalOpened: (...a: unknown[]) => openedMock(...a),
  noteSetupTerminalClosed: (...a: unknown[]) => closedMock(...a),
}));
const ctorOpts: unknown[] = [];
vi.mock("@/lib/terminal/manager", () => ({
  TerminalManager: class {
    constructor(_factory: unknown, opts: unknown) {
      ctorOpts.push(opts);
    }
    sweepIdleSetupTerminals(): void {}
  },
}));

beforeEach(() => {
  invalidateMock.mockReset();
  clearRegistrationMock.mockReset();
  clearProviderMock.mockReset();
  warnMock.mockReset();
  openedMock.mockReset();
  closedMock.mockReset();
  probe.started.mockReset();
  probe.ended.mockReset();
  probe.endAll.mockReset();
});

// Claude Code must not be asked about an entry while its `mcp login` runs (lib/providers/claude-signin-probe.ts);
// the setup scripts announce its start and end in the terminal's output.
describe("setup terminal output hook", () => {
  it("the manager is built with it, and it hands each sign-in's start and end to the probe, per terminal", async () => {
    const { getTerminalManager, handleSetupTerminalOutput } = await import("@/lib/terminal/instance");
    getTerminalManager();
    expect((ctorOpts.at(-1) as { onSetupTerminalOutput?: unknown }).onSetupTerminalOutput).toBe(handleSetupTerminalOutput);
    handleSetupTerminalOutput("t-1", "Claude Code adds ElevenLabs...\r\n[libi sign-in st");
    handleSetupTerminalOutput("t-2", "art: other]\r\n");
    expect(probe.started).not.toHaveBeenCalled();
    handleSetupTerminalOutput("t-1", "art: elevenlabs]\r\n");
    expect(probe.started).toHaveBeenCalledWith("elevenlabs", "t-1");
    handleSetupTerminalOutput("t-1", "[libi sign-in end: elevenlabs]\r\n");
    expect(probe.ended).toHaveBeenCalledWith("elevenlabs");
  });

  it("a terminal that goes away ends the sign-ins it was running", async () => {
    const { handleSetupTerminalExit } = await import("@/lib/terminal/instance");
    handleSetupTerminalExit("providers", "t-9");
    expect(probe.endAll).toHaveBeenCalledWith("t-9");
    expect(clearProviderMock).toHaveBeenCalledTimes(1);
  });

  it("never throws", async () => {
    probe.started.mockImplementation(() => {
      throw new Error("boom");
    });
    const { handleSetupTerminalOutput } = await import("@/lib/terminal/instance");
    expect(() => handleSetupTerminalOutput("t-3", "[libi sign-in start: x]")).not.toThrow();
    expect(warnMock).toHaveBeenCalledWith({ tag: "terminal", op: "setup_output_hook_failed" }, expect.any(String));
  });
});

describe("setup terminal exit hook", () => {
  it("the terminal manager is built with the hook, and the hook drops every agent's CLI, registration and provider-detection memo", async () => {
    const { getTerminalManager, handleSetupTerminalExit } = await import("@/lib/terminal/instance");
    getTerminalManager();
    const opts = ctorOpts.at(-1) as { onSetupTerminalExit?: unknown };
    expect(opts.onSetupTerminalExit).toBe(handleSetupTerminalExit);
    handleSetupTerminalExit();
    expect(invalidateMock).toHaveBeenCalledWith();
    expect(clearRegistrationMock).toHaveBeenCalledTimes(1);
    expect(clearProviderMock).toHaveBeenCalledTimes(1);
  });

  it("reports every setup terminal's open and close to the setup activity a pre-created chat is judged by", async () => {
    const { getTerminalManager, handleSetupTerminalExit } = await import("@/lib/terminal/instance");
    getTerminalManager();
    const opts = ctorOpts.at(-1) as { onSetupTerminalOpen?: (surface: string) => void };
    opts.onSetupTerminalOpen?.("providers");
    expect(openedMock).toHaveBeenCalledTimes(1);
    handleSetupTerminalExit();
    expect(closedMock).toHaveBeenCalledTimes(1);
  });

  it("never throws when recording the close fails, and every memo is still dropped", async () => {
    closedMock.mockImplementation(() => {
      throw new Error("boom");
    });
    const { handleSetupTerminalExit } = await import("@/lib/terminal/instance");
    expect(() => handleSetupTerminalExit()).not.toThrow();
    expect(warnMock).toHaveBeenCalledWith({ tag: "terminal", op: "setup_exit_hook_failed" }, expect.any(String));
    expect(invalidateMock).toHaveBeenCalledWith();
    expect(clearRegistrationMock).toHaveBeenCalledTimes(1);
    expect(clearProviderMock).toHaveBeenCalledTimes(1);
  });

  it("never throws when the provider-detection memo clear fails, and the other memos are still dropped", async () => {
    clearProviderMock.mockImplementation(() => {
      throw new Error("boom");
    });
    const { handleSetupTerminalExit } = await import("@/lib/terminal/instance");
    expect(() => handleSetupTerminalExit()).not.toThrow();
    expect(invalidateMock).toHaveBeenCalledWith();
    expect(clearRegistrationMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith({ tag: "terminal", op: "setup_exit_hook_failed" }, expect.any(String));
  });

  it("never throws: a failing invalidate is logged with tag + op and swallowed", async () => {
    invalidateMock.mockImplementation(() => {
      throw new Error("boom");
    });
    const { handleSetupTerminalExit } = await import("@/lib/terminal/instance");
    expect(() => handleSetupTerminalExit()).not.toThrow();
    expect(warnMock).toHaveBeenCalledWith({ tag: "terminal", op: "setup_exit_hook_failed" }, expect.any(String));
    // One failing clear never skips the others.
    expect(clearRegistrationMock).toHaveBeenCalledTimes(1);
    expect(clearProviderMock).toHaveBeenCalledTimes(1);
  });

  it("never throws when the registration memo clear fails, and the CLI memo is still dropped", async () => {
    clearRegistrationMock.mockImplementation(() => {
      throw new Error("boom");
    });
    const { handleSetupTerminalExit } = await import("@/lib/terminal/instance");
    expect(() => handleSetupTerminalExit()).not.toThrow();
    expect(invalidateMock).toHaveBeenCalledWith();
    expect(warnMock).toHaveBeenCalledWith({ tag: "terminal", op: "setup_exit_hook_failed" }, expect.any(String));
  });
});
