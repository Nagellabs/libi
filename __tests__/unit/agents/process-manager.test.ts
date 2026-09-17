import { vi, describe, it, expect, beforeEach, afterEach, type Mock } from "vitest";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

// Mock child_process.spawn
const mockChildProcess = () => {
  const cp = new EventEmitter() as EventEmitter & {
    stdin: { write: Mock };
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    exitCode: number | null;
    signalCode: string | null;
    kill: Mock;
    pid: number;
  };
  cp.stdin = { write: vi.fn() };
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.killed = false;
  cp.exitCode = null;
  cp.signalCode = null;
  cp.pid = 12345;
  cp.kill = vi.fn((signal?: string) => {
    cp.killed = true;
    cp.exitCode = signal === "SIGKILL" ? 137 : 0;
    cp.emit("exit", cp.exitCode, signal);
    return true;
  });
  return cp;
};

vi.mock("child_process", () => ({
  spawn: vi.fn(() => mockChildProcess()),
}));

// Mock the ACP SDK
const mockInitialize = vi.fn().mockResolvedValue({
  protocolVersion: 1,
  agentCapabilities: {
    sessionCapabilities: { list: true },
  },
});
const mockNewSession = vi.fn().mockResolvedValue({ sessionId: "acp-session-1" });
const mockPrompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
const mockCloseSession = vi.fn().mockResolvedValue({});
const mockListSessions = vi.fn().mockResolvedValue({ sessions: [], nextCursor: null });
const mockLoadSession = vi.fn().mockResolvedValue(undefined);

vi.mock("@agentclientprotocol/sdk", () => {
  class MockClientSideConnection {
    constructor(toClient: (agent: unknown) => unknown, _stream: unknown) {
      // Call the toClient factory so the client handler is wired up
      toClient({});
    }
    initialize = mockInitialize;
    newSession = mockNewSession;
    prompt = mockPrompt;
    closeSession = mockCloseSession;
    listSessions = mockListSessions;
    loadSession = mockLoadSession;
  }
  return {
    ClientSideConnection: MockClientSideConnection,
    ndJsonStream: vi.fn().mockReturnValue({
      writable: {} as WritableStream,
      readable: {} as ReadableStream,
    }),
    PROTOCOL_VERSION: 1,
  };
});

// Mock stream conversions (Readable.toWeb / Writable.toWeb)
vi.mock("stream", () => ({
  Readable: {
    toWeb: vi.fn().mockReturnValue({} as ReadableStream),
  },
  Writable: {
    toWeb: vi.fn().mockReturnValue({} as WritableStream),
  },
}));

// Mock workspace + instructions
vi.mock("@/mcp/workspace", () => ({
  prepareAgentDir: vi.fn((pieceId: string) => `/tmp/workspace/${pieceId}`),
}));

vi.mock("@/mcp/instructions", () => ({
  getInstructions: vi.fn(() => "mock instructions"),
}));

vi.mock("@/lib/db/sessions", () => ({
  updateSessionName: vi.fn(),
}));

// Mock agent registry — return a known installed agent
vi.mock("@/lib/agents/acp/agent-registry", () => ({
  getAgentConfig: vi.fn((id: string) => {
    if (id === "claude-code") {
      return {
        id: "claude-code",
        name: "Claude Code",
        command: "claude-agent-acp",
        args: [],
        detectCommand: "claude",
        envHints: ["ANTHROPIC_API_KEY"],
        installed: true,
      };
    }
    if (id === "codex") {
      return {
        id: "codex",
        name: "Codex CLI",
        command: "codex-acp",
        args: [],
        detectCommand: "codex",
        envHints: ["OPENAI_API_KEY"],
        installed: true,
      };
    }
    if (id === "not-installed") {
      return {
        id: "not-installed",
        name: "Not Installed",
        command: "nope",
        args: [],
        detectCommand: "nope",
        envHints: [],
        installed: false,
      };
    }
    return undefined;
  }),
}));

// The adapter is told which CLI to exec; without a resolver mock a real login
// shell would run, and fail wherever `claude`/`codex` are absent (CI).
vi.mock("@/lib/agents/cli/resolve", () => ({
  resolveAgentCli: async () => ({ path: "/u/bin/cli", realPath: "/u/bin/cli", execPath: "/u/bin/cli", version: "9.0.0", meetsMinimum: true }),
  isUsableCli: (r: { meetsMinimum?: boolean } | null) => !!r && r.meetsMinimum === true,
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------

import { AgentProcessManager } from "@/lib/agents/process-manager";
import { AgentSpawnRefusedError } from "@/lib/agents/spawn-refused-error";
import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentProcessManager", () => {
  let pm: AgentProcessManager;
  let mockSessionManagerShutdown: ReturnType<typeof vi.fn>;
  let mockCreateClient: ReturnType<typeof vi.fn>;
  let mockOnProcessCrash: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    pm = new AgentProcessManager();

    // Inject hooks (replaces the old require() pattern)
    mockSessionManagerShutdown = vi.fn().mockResolvedValue(undefined);
    mockCreateClient = vi.fn().mockReturnValue({
      sessionUpdate: vi.fn(),
      requestPermission: vi.fn(),
    });
    mockOnProcessCrash = vi.fn();

    pm.setSessionManagerHooks({
      shutdown: mockSessionManagerShutdown,
      createClient: mockCreateClient,
      onProcessCrash: mockOnProcessCrash,
    });
  });

  afterEach(async () => {
    await pm.shutdown();
  });

  // -----------------------------------------------------------------------
  // warmProcess
  // -----------------------------------------------------------------------

  describe("warmProcess", () => {
    it("spawns a process on first call", async () => {
      await pm.warmProcess("claude-code");

      expect(spawn).toHaveBeenCalledOnce();
      expect(mockInitialize).toHaveBeenCalledOnce();
    });

    it("is a no-op if process already exists", async () => {
      await pm.warmProcess("claude-code");
      await pm.warmProcess("claude-code");

      expect(spawn).toHaveBeenCalledOnce();
    });

    it("spawns separate processes for different agents", async () => {
      await pm.warmProcess("claude-code");
      await pm.warmProcess("codex");

      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it("refuses an agent that is not installed with the typed spawn refusal", async () => {
      const err = await pm.warmProcess("not-installed").then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(AgentSpawnRefusedError);
      expect((err as Error).message).toContain("not installed");
      expect(spawn).not.toHaveBeenCalled();
    });

    it("refuses an unknown agent with the typed spawn refusal", async () => {
      const err = await pm.warmProcess("unknown-agent").then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(AgentSpawnRefusedError);
      expect((err as AgentSpawnRefusedError).agentId).toBe("unknown-agent");
      expect((err as Error).message).toContain("not installed");
    });
  });

  describe("shell environment at spawn, and restartProcess", () => {
    let envSnapshot: NodeJS.ProcessEnv;
    beforeEach(() => {
      envSnapshot = { ...process.env };
    });
    afterEach(() => {
      process.env = envSnapshot;
    });

    it("records whether the environment was loaded when the process was SPAWNED — never re-read", async () => {
      process.env.LIBI_SHELL_ENV = "pending";
      await pm.warmProcess("claude-code");
      expect(pm.spawnedWithShellEnv("claude-code")).toBe(false);
      process.env.LIBI_SHELL_ENV = "loaded";
      expect(pm.spawnedWithShellEnv("claude-code")).toBe(false);
      expect(pm.spawnedWithShellEnv("codex")).toBe(true); // no process yet: what a spawn now would get
    });

    it("absent (npx, dev, Windows) counts as loaded; failed does not", async () => {
      delete process.env.LIBI_SHELL_ENV;
      await pm.warmProcess("claude-code");
      expect(pm.spawnedWithShellEnv("claude-code")).toBe(true);
      process.env.LIBI_SHELL_ENV = "failed";
      await pm.warmProcess("codex");
      expect(pm.spawnedWithShellEnv("codex")).toBe(false);
    });

    it("restartProcess replaces the process; the retired one's exit neither reports a crash nor removes the new one", async () => {
      process.env.LIBI_SHELL_ENV = "pending";
      await pm.warmProcess("claude-code");
      const retired = vi.mocked(spawn).mock.results[0].value as EventEmitter & { kill: Mock };
      process.env.LIBI_SHELL_ENV = "loaded";
      await pm.restartProcess("claude-code");
      expect(retired.kill).toHaveBeenCalledWith("SIGTERM");
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(pm.spawnedWithShellEnv("claude-code")).toBe(true);
      const conn = pm.getConnection("claude-code");
      expect(conn).not.toBeNull();
      retired.emit("exit", 1, null); // a late, non-zero exit from the retired process
      expect(mockOnProcessCrash).not.toHaveBeenCalled();
      expect(pm.getConnection("claude-code")).toBe(conn);
    });

    it("pendingRestart is null when idle, covers the no-connection window, and settles without rejecting when the restart fails", async () => {
      await pm.warmProcess("claude-code");
      expect(pm.pendingRestart("claude-code")).toBeNull();

      const restart = pm.restartProcess("claude-code");
      expect(pm.getConnection("claude-code")).toBeNull();
      const pending = pm.pendingRestart("claude-code");
      expect(pending).not.toBeNull();
      await pending;
      expect(pm.getConnection("claude-code")).not.toBeNull();
      await restart;
      expect(pm.pendingRestart("claude-code")).toBeNull();

      mockInitialize.mockRejectedValueOnce(new Error("ACP initialize timed out for claude-code"));
      const failing = pm.restartProcess("claude-code");
      await expect(pm.pendingRestart("claude-code")).resolves.toBeUndefined();
      await expect(failing).rejects.toThrow("timed out");
      expect(pm.getConnection("claude-code")).toBeNull();
      expect(pm.pendingRestart("claude-code")).toBeNull();
    });

    it("terminateAll and shutdown forget the spawn-time answer together with the processes", async () => {
      /** A child that ignores SIGTERM: it is let go after the grace period, its exit still unseen. */
      const stubborn = (index: number) => {
        const child = vi.mocked(spawn).mock.results[index].value as EventEmitter & { kill: Mock; killed: boolean };
        child.kill.mockImplementation(() => {
          child.killed = true;
          return true;
        });
      };
      process.env.LIBI_SHELL_ENV = "pending";
      await pm.warmProcess("claude-code");
      await pm.warmProcess("codex");
      stubborn(0);
      stubborn(1);
      process.env.LIBI_SHELL_ENV = "loaded";
      expect(pm.spawnedWithShellEnv("claude-code")).toBe(false);

      vi.useFakeTimers();
      try {
        const terminated = pm.terminateAll();
        await vi.advanceTimersByTimeAsync(3000);
        expect(await terminated).toBe(2);
        expect(pm.spawnedWithShellEnv("claude-code")).toBe(true);
        expect(pm.spawnedWithShellEnv("codex")).toBe(true);
      } finally {
        vi.useRealTimers();
      }

      process.env.LIBI_SHELL_ENV = "pending";
      await pm.warmProcess("codex");
      stubborn(2);
      process.env.LIBI_SHELL_ENV = "loaded";
      expect(pm.spawnedWithShellEnv("codex")).toBe(false);
      vi.useFakeTimers();
      try {
        const shutdown = pm.shutdown();
        await vi.advanceTimersByTimeAsync(3000);
        await shutdown;
        expect(pm.spawnedWithShellEnv("codex")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("concurrent starts", () => {
    it("two concurrent starts of the same agent spawn ONE process", async () => {
      await Promise.all([pm.warmProcess("claude-code"), pm.warmProcess("claude-code")]);
      expect(spawn).toHaveBeenCalledOnce();
      expect(pm.getConnection("claude-code")).not.toBeNull();
    });

    it("a start during a restart shares the replacement instead of spawning a second one", async () => {
      await pm.warmProcess("claude-code");
      await Promise.all([pm.restartProcess("claude-code"), pm.warmProcess("claude-code")]);
      expect(spawn).toHaveBeenCalledTimes(2); // the original and ONE replacement
      const replacement = vi.mocked(spawn).mock.results[1].value as EventEmitter & { kill: Mock };
      expect(replacement.kill).not.toHaveBeenCalled();
    });

    it("a failed start is not remembered: the next start spawns again", async () => {
      mockInitialize.mockRejectedValueOnce(new Error("boom"));
      await expect(pm.warmProcess("claude-code")).rejects.toThrow("boom");
      await pm.warmProcess("claude-code");
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(pm.getConnection("claude-code")).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getConnection
  // -----------------------------------------------------------------------

  describe("a killed process's late exit", () => {
    type FakeChild = EventEmitter & { kill: Mock; killed: boolean };
    /** Signalled, but its exit is not seen yet: the kill gives up on it after the 3 s grace. */
    const ignoreSigterm = (child: FakeChild) => {
      child.kill.mockImplementation(() => {
        child.killed = true;
        return true;
      });
    };
    const child = (index: number) => vi.mocked(spawn).mock.results[index].value as FakeChild;

    it("terminateAll: an exit or error that lands after the respawn neither reports a crash nor drops the new process", async () => {
      await pm.warmProcess("claude-code");
      const old = child(0);
      ignoreSigterm(old);
      vi.useFakeTimers();
      try {
        const terminated = pm.terminateAll();
        await vi.advanceTimersByTimeAsync(3000);
        expect(await terminated).toBe(1);
      } finally {
        vi.useRealTimers();
      }

      await pm.warmProcess("claude-code"); // the respawn, as regenerateAndRestart's next chat does
      expect(spawn).toHaveBeenCalledTimes(2);
      const conn = pm.getConnection("claude-code");
      expect(conn).not.toBeNull();

      old.emit("error", new Error("write EPIPE"));
      old.emit("exit", 1, null);
      old.emit("exit", 0, null);
      expect(mockOnProcessCrash).not.toHaveBeenCalled();
      expect(pm.getConnection("claude-code")).toBe(conn);
    });

    it("terminateAll: a process that initializes while the kills are still waiting survives the terminate", async () => {
      await pm.warmProcess("claude-code");
      ignoreSigterm(child(0));
      vi.useFakeTimers();
      try {
        const terminated = pm.terminateAll();
        await pm.warmProcess("codex"); // lands during the 3 s grace
        await vi.advanceTimersByTimeAsync(3000);
        expect(await terminated).toBe(1);
      } finally {
        vi.useRealTimers();
      }
      expect(pm.getConnection("claude-code")).toBeNull();
      expect(pm.getConnection("codex")).not.toBeNull();
    });

    it("a child killed after a failed initialize: its exit landing after the next spawn has initialized touches nothing", async () => {
      const failed = mockChildProcess();
      ignoreSigterm(failed as unknown as FakeChild);
      vi.mocked(spawn).mockImplementationOnce(() => failed as never);
      mockInitialize.mockRejectedValueOnce(new Error("ACP initialize timed out for claude-code"));
      await expect(pm.warmProcess("claude-code")).rejects.toThrow("timed out");
      expect(failed.kill).toHaveBeenCalledWith("SIGTERM");

      await pm.warmProcess("claude-code");
      const conn = pm.getConnection("claude-code");
      expect(conn).not.toBeNull();

      failed.emit("exit", 1, null);
      expect(mockOnProcessCrash).not.toHaveBeenCalled();
      expect(pm.getConnection("claude-code")).toBe(conn);
    });

    it("the CURRENT process crashing is still reported and removed", async () => {
      await pm.warmProcess("claude-code");
      child(0).emit("exit", 1, null);
      expect(mockOnProcessCrash).toHaveBeenCalledWith("claude-code", "Process exited with code 1");
      expect(pm.getConnection("claude-code")).toBeNull();
    });

    it("the CURRENT process killed by a signal libi did not send (an OOM SIGKILL) is reported as a crash and removed", async () => {
      await pm.warmProcess("claude-code");
      child(0).emit("exit", null, "SIGKILL");
      expect(mockOnProcessCrash).toHaveBeenCalledWith("claude-code", "Process was killed by SIGKILL");
      expect(pm.getConnection("claude-code")).toBeNull();
    });

    it("once the server is exiting, a SIGINT or SIGTERM exit of a current process is not reported as a crash", async () => {
      await pm.warmProcess("claude-code");
      await pm.warmProcess("codex");
      pm.retireAllForExit();

      // Ctrl+C reaches the adapters directly, while the shutdown still waits on other children.
      child(0).emit("exit", null, "SIGINT");
      child(1).emit("exit", null, "SIGTERM");
      expect(mockOnProcessCrash).not.toHaveBeenCalled();
    });

    it("once the server is exiting, a process that finishes initializing afterwards is not reported either", async () => {
      let initialize!: () => void;
      mockInitialize.mockReturnValueOnce(
        new Promise((resolve) => {
          initialize = () => resolve({ protocolVersion: 1, agentCapabilities: {} });
        }),
      );
      const warming = pm.warmProcess("claude-code");
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      pm.retireAllForExit();
      initialize();
      await warming;

      child(0).emit("exit", null, "SIGINT");
      expect(mockOnProcessCrash).not.toHaveBeenCalled();
    });

    it("a signal exit of a process libi retired (restart) is not reported and leaves the replacement alone", async () => {
      await pm.warmProcess("claude-code");
      const old = child(0);
      ignoreSigterm(old);
      vi.useFakeTimers();
      try {
        const restarted = pm.restartProcess("claude-code");
        await vi.advanceTimersByTimeAsync(3000);
        await restarted;
      } finally {
        vi.useRealTimers();
      }
      const conn = pm.getConnection("claude-code");
      expect(conn).not.toBeNull();

      old.emit("exit", null, "SIGTERM");
      old.emit("exit", null, "SIGKILL");
      expect(mockOnProcessCrash).not.toHaveBeenCalled();
      expect(pm.getConnection("claude-code")).toBe(conn);
    });
  });

  describe("killing a child that ignores SIGTERM", () => {
    type FakeChild = EventEmitter & { kill: Mock; killed: boolean; exitCode: number | null; signalCode: string | null };
    /** Records the signal the way Node does (`killed` turns true on SEND) but never exits. */
    const ignoreAllSignals = (c: FakeChild) => {
      c.kill.mockImplementation(() => {
        c.killed = true;
        return true;
      });
    };
    const signalsSent = (c: FakeChild) => c.kill.mock.calls.map((call) => call[0]);

    it("terminateAll SIGKILLs a child still running 3 s after SIGTERM", async () => {
      await pm.warmProcess("claude-code");
      const c = vi.mocked(spawn).mock.results[0].value as FakeChild;
      ignoreAllSignals(c);
      vi.useFakeTimers();
      try {
        const terminated = pm.terminateAll();
        expect(signalsSent(c)).toEqual(["SIGTERM"]);
        await vi.advanceTimersByTimeAsync(2999);
        expect(signalsSent(c)).toEqual(["SIGTERM"]);
        await vi.advanceTimersByTimeAsync(1);
        expect(signalsSent(c)).toEqual(["SIGTERM", "SIGKILL"]);
        expect(await terminated).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a child that exits on SIGTERM within the grace is not SIGKILLed", async () => {
      await pm.warmProcess("claude-code");
      const c = vi.mocked(spawn).mock.results[0].value as FakeChild;
      ignoreAllSignals(c);
      vi.useFakeTimers();
      try {
        const terminated = pm.terminateAll();
        await vi.advanceTimersByTimeAsync(1000);
        c.signalCode = "SIGTERM";
        c.emit("exit", null, "SIGTERM");
        await vi.advanceTimersByTimeAsync(5000);
        expect(await terminated).toBe(1);
      } finally {
        vi.useRealTimers();
      }
      expect(signalsSent(c)).toEqual(["SIGTERM"]);
    });

    it("the kill after a failed initialize escalates to SIGKILL too", async () => {
      const failed = mockChildProcess() as unknown as FakeChild;
      ignoreAllSignals(failed);
      vi.mocked(spawn).mockImplementationOnce(() => failed as never);
      mockInitialize.mockRejectedValueOnce(new Error("ACP initialize timed out for claude-code"));
      vi.useFakeTimers();
      try {
        await expect(pm.warmProcess("claude-code")).rejects.toThrow("timed out");
        expect(signalsSent(failed)).toEqual(["SIGTERM"]);
        await vi.advanceTimersByTimeAsync(3000);
        expect(signalsSent(failed)).toEqual(["SIGTERM", "SIGKILL"]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("getConnection", () => {
    it("returns null when no process exists", () => {
      expect(pm.getConnection("claude-code")).toBeNull();
    });

    it("returns a connection after warming", async () => {
      await pm.warmProcess("claude-code");

      const conn = pm.getConnection("claude-code");
      expect(conn).not.toBeNull();
      expect(conn!.initialize).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // getCapabilitiesForAgent
  // -----------------------------------------------------------------------

  describe("getCapabilitiesForAgent", () => {
    it("returns canListSessions: false when no process exists", () => {
      const caps = pm.getCapabilitiesForAgent("claude-code");
      expect(caps.canListSessions).toBe(false);
    });

    it("returns canListSessions: true when agent reports session list capability", async () => {
      await pm.warmProcess("claude-code");

      const caps = pm.getCapabilitiesForAgent("claude-code");
      expect(caps.canListSessions).toBe(true);
    });

    it("returns canListSessions: false when agent has no session capabilities", async () => {
      mockInitialize.mockResolvedValueOnce({
        protocolVersion: 1,
        agentCapabilities: {},
      });

      await pm.warmProcess("codex");

      const caps = pm.getCapabilitiesForAgent("codex");
      expect(caps.canListSessions).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // registerSessionId / unregisterSessionId
  // -----------------------------------------------------------------------

  describe("registerSessionId / unregisterSessionId", () => {
    it("is a no-op when no process exists", () => {
      // Should not throw
      pm.registerSessionId("claude-code", "session-1");
      pm.unregisterSessionId("claude-code", "session-1");
    });

    it("adds and removes session IDs from the process's known set", async () => {
      await pm.warmProcess("claude-code");

      pm.registerSessionId("claude-code", "session-1");
      pm.registerSessionId("claude-code", "session-2");

      // We can't directly inspect the Set, but we can verify no errors
      // and that unregistering works (tested indirectly via event routing)
      pm.unregisterSessionId("claude-code", "session-1");
      pm.unregisterSessionId("claude-code", "session-2");
    });
  });

  // -----------------------------------------------------------------------
  // shutdown
  // -----------------------------------------------------------------------

  describe("shutdown", () => {
    it("shuts down session manager and kills all processes", async () => {
      await pm.warmProcess("claude-code");
      await pm.warmProcess("codex");

      await pm.shutdown();

      // Session manager shutdown was called via hooks
      expect(mockSessionManagerShutdown).toHaveBeenCalledOnce();

      // Connections should be gone after shutdown
      expect(pm.getConnection("claude-code")).toBeNull();
      expect(pm.getConnection("codex")).toBeNull();
    });

    it("is safe to call when no processes exist", async () => {
      await pm.shutdown();

      expect(mockSessionManagerShutdown).toHaveBeenCalledOnce();
    });
  });
});
