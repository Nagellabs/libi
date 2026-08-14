import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/libi-home", () => ({
  getLibiAgentDir: vi.fn(() => "/tmp/libi-test-agent"),
  ensureLibiDirs: vi.fn(),
  getLibiLogDir: vi.fn(() => "/tmp/libi-test-logs"),
}));
vi.mock("@/lib/mcp-config", () => ({
  getMcpServersForAcp: vi.fn(() => []),
  onMcpConfigInvalidated: vi.fn(),
}));
vi.mock("@/lib/approval/settings", () => ({
  getApprovalMode: vi.fn(() => "auto"),
}));
// Controllable per-agent model-preference store (avoids the settings DB).
vi.mock("@/lib/sessions/model-preferences", () => ({
  getAgentModelId: vi.fn(() => null),
  setAgentModelId: vi.fn(),
}));
vi.mock("@/lib/agents/session-event-handler", () => ({
  SessionEventHandler: vi.fn().mockImplementation(() => ({
    createClient: vi.fn().mockReturnValue({}),
    cleanUserMessageParts: vi.fn(),
  })),
}));

import { SessionManager } from "@/lib/sessions/session-manager";
import { getAgentModelId, setAgentModelId } from "@/lib/sessions/model-preferences";

function modelConfigOptions(current: string) {
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: current,
      options: [
        { value: "claude-opus-4-8", name: "Opus 4.8" },
        { value: "claude-sonnet-4-6", name: "Sonnet 4.6" },
      ],
    },
  ];
}

function createMockPm(configOptions: unknown[]) {
  const mockConnection = {
    listSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
    newSession: vi.fn().mockResolvedValue({ sessionId: "s-1", configOptions }),
    loadSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    setSessionMode: vi.fn().mockResolvedValue(undefined),
    setSessionConfigOption: vi.fn().mockResolvedValue({ configOptions: [] }),
  };
  return {
    pm: {
      getConnection: vi.fn().mockReturnValue(mockConnection),
      warmProcess: vi.fn().mockResolvedValue(undefined),
      getCapabilitiesForAgent: vi.fn().mockReturnValue({ canListSessions: true }),
      registerSessionId: vi.fn(),
      unregisterSessionId: vi.fn(),
    },
    mockConnection,
  };
}

describe("SessionManager model selection", () => {
  let sm: SessionManager;
  let pm: ReturnType<typeof createMockPm>["pm"];
  let mockConnection: ReturnType<typeof createMockPm>["mockConnection"];

  beforeEach(async () => {
    vi.clearAllMocks();
    const mocks = createMockPm(modelConfigOptions("claude-opus-4-8"));
    pm = mocks.pm;
    mockConnection = mocks.mockConnection;
    sm = new SessionManager();
    sm.setProcessManager(pm);
    await sm.loadInitialSessions("claude-code");
  });

  it("getSessionModelState returns the captured model state", async () => {
    const id = await sm.createSession();
    expect(sm.getSessionModelState(id)).toEqual({
      currentModelId: "claude-opus-4-8",
      availableModels: [
        { id: "claude-opus-4-8", name: "Opus 4.8", description: undefined },
        { id: "claude-sonnet-4-6", name: "Sonnet 4.6", description: undefined },
      ],
    });
  });

  it("getSessionModelState returns null for unknown session", () => {
    expect(sm.getSessionModelState("nope")).toBeNull();
  });

  it("setSessionModel calls setSessionConfigOption with configId 'model' and updates state", async () => {
    const id = await sm.createSession();
    await sm.setSessionModel(id, "claude-sonnet-4-6");

    expect(mockConnection.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: id,
      configId: "model",
      value: "claude-sonnet-4-6",
    });
    expect(sm.getSessionModelState(id)!.currentModelId).toBe("claude-sonnet-4-6");
  });

  it("setSessionModel throws for an unknown session", async () => {
    await expect(sm.setSessionModel("nope", "x")).rejects.toThrow("not found");
  });

  it("setSessionModel surfaces a connection error without corrupting state", async () => {
    const id = await sm.createSession();
    mockConnection.setSessionConfigOption.mockRejectedValueOnce(new Error("boom"));
    await expect(sm.setSessionModel(id, "claude-sonnet-4-6")).rejects.toThrow("boom");
    expect(sm.getSessionModelState(id)!.currentModelId).toBe("claude-opus-4-8");
  });

  it("setSessionModel persists the choice per-agent via setAgentModelId", async () => {
    const id = await sm.createSession();
    await sm.setSessionModel(id, "claude-sonnet-4-6");
    expect(setAgentModelId).toHaveBeenCalledWith("claude-code", "claude-sonnet-4-6");
  });

  it("re-applies the saved per-agent model to a newly created session", async () => {
    // User previously picked sonnet; the agent's new session opens on opus.
    vi.mocked(getAgentModelId).mockReturnValue("claude-sonnet-4-6");
    const id = await sm.createSession();
    // pushModelToSession should have switched the new session to the saved model.
    expect(mockConnection.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: id,
      configId: "model",
      value: "claude-sonnet-4-6",
    });
    expect(sm.getSessionModelState(id)!.currentModelId).toBe("claude-sonnet-4-6");
  });

  it("does not re-apply when the saved model already matches the session's current model", async () => {
    vi.mocked(getAgentModelId).mockReturnValue("claude-opus-4-8");
    await sm.createSession();
    // No switch needed — the new session already opens on the saved model.
    expect(mockConnection.setSessionConfigOption).not.toHaveBeenCalled();
  });

  it("does not re-apply when the saved model is not offered by the agent", async () => {
    vi.mocked(getAgentModelId).mockReturnValue("some-unavailable-model");
    await sm.createSession();
    expect(mockConnection.setSessionConfigOption).not.toHaveBeenCalled();
  });
});
