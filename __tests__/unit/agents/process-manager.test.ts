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
    kill: Mock;
    pid: number;
  };
  cp.stdin = { write: vi.fn() };
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.killed = false;
  cp.exitCode = null;
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

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------

import { AgentProcessManager } from "@/lib/agents/process-manager";
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

    it("throws for an agent that is not installed", async () => {
      await expect(pm.warmProcess("not-installed")).rejects.toThrow(
        "not installed"
      );
    });

    it("throws for an unknown agent", async () => {
      await expect(pm.warmProcess("unknown-agent")).rejects.toThrow(
        "not installed"
      );
    });
  });

  // -----------------------------------------------------------------------
  // getConnection
  // -----------------------------------------------------------------------

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
