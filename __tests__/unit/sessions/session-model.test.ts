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
import type { AgentEvent } from "@/lib/agents/types";

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
    // `clearAllMocks` clears recorded calls but NOT implementations, so a
    // `mockReturnValue` set by one test leaks into every later one — which is
    // how "no saved model" silently became the state under test and let the
    // re-apply path go unexercised. Reset the preference explicitly; tests
    // that need a saved model set it themselves.
    vi.mocked(getAgentModelId).mockReturnValue(null);
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

  it("getSessionModelSnapshot reports pending for a history-discovered session whose options are uncaptured", async () => {
    // Sessions discovered from the agent's history register with
    // configOptions: [] and stay empty until activation's loadSession fills
    // them — the window the picker used to lose the race in.
    mockConnection.listSessions.mockResolvedValue({
      sessions: [{ sessionId: "restored-1", title: null, updatedAt: null }],
      nextCursor: null,
    });
    await sm.loadInitialSessions("claude-code");
    expect(sm.getSessionModelSnapshot("restored-1")).toEqual({
      supported: false,
      pending: true,
    });
  });

  it("getSessionModelSnapshot returns null for an unknown session", () => {
    expect(sm.getSessionModelSnapshot("nope")).toBeNull();
  });

  it("getSessionModelSnapshot wraps the model state once options are captured", async () => {
    const id = await sm.createSession();
    expect(sm.getSessionModelSnapshot(id)).toEqual({
      supported: true,
      currentModelId: "claude-opus-4-8",
      availableModels: [
        { id: "claude-opus-4-8", name: "Opus 4.8", description: undefined },
        { id: "claude-sonnet-4-6", name: "Sonnet 4.6", description: undefined },
      ],
    });
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

  it("emits agent-config-options after loadSession fills a restored session's options", async () => {
    // The event that un-sticks the picker: the client's GET raced activation,
    // cached {supported:false, pending:true}, and this is what patches it.
    mockConnection.listSessions.mockResolvedValue({
      sessions: [{ sessionId: "restored-1", title: null, updatedAt: null }],
      nextCursor: null,
    });
    await sm.loadInitialSessions("claude-code");

    const events: AgentEvent[] = [];
    sm.onEvent("restored-1", (e) => events.push(e));
    mockConnection.loadSession.mockResolvedValue({
      configOptions: modelConfigOptions("claude-opus-4-8"),
    });
    await sm.activateSession("restored-1");

    const evt = events.find((e) => e.type === "agent-config-options");
    expect(evt).toBeDefined();
    expect((evt as Extract<AgentEvent, { type: "agent-config-options" }>).model).toEqual({
      supported: true,
      currentModelId: "claude-opus-4-8",
      availableModels: [
        { id: "claude-opus-4-8", name: "Opus 4.8", description: undefined },
        { id: "claude-sonnet-4-6", name: "Sonnet 4.6", description: undefined },
      ],
    });
  });

  it("emitted snapshot carries the RE-APPLIED saved model, not the loadSession value", async () => {
    // The invariant the activation emit exists to protect: `performActivation`
    // fills `entry.configOptions` from `loadSession`, THEN re-pushes the
    // user's saved model (which rewrites `currentValue`), THEN emits. Move the
    // emit up to the fill site and the snapshot carries the agent's default
    // instead of the user's choice — with no later event to correct it, so the
    // picker shows the wrong model for the life of the session.
    //
    // The two values must differ for this to bite: loadSession opens the
    // restored session on opus while the saved preference is sonnet. Sonnet
    // must also be among the offered options, or `pushModelToSession` skips.
    vi.mocked(getAgentModelId).mockReturnValue("claude-sonnet-4-6");
    mockConnection.listSessions.mockResolvedValue({
      sessions: [{ sessionId: "restored-1", title: null, updatedAt: null }],
      nextCursor: null,
    });
    await sm.loadInitialSessions("claude-code");

    const events: AgentEvent[] = [];
    sm.onEvent("restored-1", (e) => events.push(e));
    mockConnection.loadSession.mockResolvedValue({
      configOptions: modelConfigOptions("claude-opus-4-8"),
    });
    await sm.activateSession("restored-1");

    // The push actually happened — otherwise pre- and post-push snapshots are
    // identical and this test would pass against the hoisted emit too.
    expect(mockConnection.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "restored-1",
      configId: "model",
      value: "claude-sonnet-4-6",
    });
    const evt = events.find((e) => e.type === "agent-config-options");
    expect(evt).toBeDefined();
    expect((evt as Extract<AgentEvent, { type: "agent-config-options" }>).model).toMatchObject({
      supported: true,
      currentModelId: "claude-sonnet-4-6",
    });
  });

  it("emits a terminal (non-pending) snapshot when activation completes with no configOptions", async () => {
    // `LoadSessionResponse.configOptions` is optional. When an adapter omits
    // it the entry's list stays empty — but activation has just FINISHED, so
    // "not known yet" is no longer true and nothing will ever fill it. A
    // `pending: true` here would leave the client on a loading skeleton
    // forever, so the emitted snapshot must terminate at `pending: false`.
    mockConnection.listSessions.mockResolvedValue({
      sessions: [{ sessionId: "restored-2", title: null, updatedAt: null }],
      nextCursor: null,
    });
    await sm.loadInitialSessions("claude-code");

    const events: AgentEvent[] = [];
    sm.onEvent("restored-2", (e) => events.push(e));
    mockConnection.loadSession.mockResolvedValue({});
    await sm.activateSession("restored-2");

    const evt = events.find((e) => e.type === "agent-config-options");
    expect(evt).toBeDefined();
    expect((evt as Extract<AgentEvent, { type: "agent-config-options" }>).model).toEqual({
      supported: false,
      pending: false,
    });
  });
});

/**
 * Every exit from `activateSession` must publish a terminal
 * `agent-config-options` — one whose `supported: false` carries
 * `pending: false`. The client resolves its loading skeleton on this frame
 * and nothing else, so an exit that emits none leaves the picker pulsing for
 * the life of the session.
 *
 * The failure exits are easy to miss because most of them throw BEFORE the
 * `loadSession` try/catch that emits `agent-status: error`, so they produce
 * no SSE frame at all.
 */
describe("SessionManager activation-failure model snapshots", () => {
  let sm: SessionManager;
  let pm: ReturnType<typeof createMockPm>["pm"];
  let mockConnection: ReturnType<typeof createMockPm>["mockConnection"];

  beforeEach(async () => {
    vi.clearAllMocks();
    // Implementations survive clearAllMocks; re-establish every one this
    // describe depends on rather than inheriting a neighbour's leftovers.
    vi.mocked(getAgentModelId).mockReturnValue(null);
    const mocks = createMockPm(modelConfigOptions("claude-opus-4-8"));
    pm = mocks.pm;
    mockConnection = mocks.mockConnection;
    sm = new SessionManager();
    sm.setProcessManager(pm);
    mockConnection.listSessions.mockResolvedValue({
      sessions: [{ sessionId: "restored-1", title: null, updatedAt: null }],
      nextCursor: null,
    });
    await sm.loadInitialSessions("claude-code");
  });

  function configOptionEvents(events: AgentEvent[]) {
    return events.filter((e) => e.type === "agent-config-options") as Array<
      Extract<AgentEvent, { type: "agent-config-options" }>
    >;
  }

  it("emits a terminal snapshot when the session is not in the map", async () => {
    // No entry means nothing will ever fill this session's options. The
    // listener is a PENDING one (registered for an id the map doesn't know),
    // which is exactly the client's position: it mounted a picker on the id
    // it just asked to activate.
    const events: AgentEvent[] = [];
    sm.onEvent("ghost", (e) => events.push(e));

    await expect(sm.activateSession("ghost")).rejects.toThrow("not found");

    expect(configOptionEvents(events).map((e) => e.model)).toEqual([
      { supported: false, pending: false },
    ]);
  });

  it("emits a terminal snapshot when no process manager is set", async () => {
    // `performActivation` throws on `!this.pm` before any status frame is
    // emitted. Reaching into the private field is the only way to get an
    // entry that exists while the manager has no pm — `loadInitialSessions`
    // needs one to have registered the entry in the first place.
    (sm as unknown as { pm: unknown }).pm = null;

    const events: AgentEvent[] = [];
    sm.onEvent("restored-1", (e) => events.push(e));

    await expect(sm.activateSession("restored-1")).rejects.toThrow(
      "No process manager set",
    );

    expect(configOptionEvents(events).map((e) => e.model)).toEqual([
      { supported: false, pending: false },
    ]);
  });

  it("emits a terminal snapshot when the agent has no connection", async () => {
    pm.getConnection.mockReturnValue(null);

    const events: AgentEvent[] = [];
    sm.onEvent("restored-1", (e) => events.push(e));

    await expect(sm.activateSession("restored-1")).rejects.toThrow(
      "No connection for agent",
    );

    expect(configOptionEvents(events).map((e) => e.model)).toEqual([
      { supported: false, pending: false },
    ]);
  });

  it("emits a terminal snapshot when loadSession throws", async () => {
    // This one DOES emit `agent-status: error` — but the client no longer
    // reads that frame for model state, because it also fires for mid-turn
    // prompt failures and process crashes.
    mockConnection.loadSession.mockRejectedValue(new Error("replay exploded"));

    const events: AgentEvent[] = [];
    sm.onEvent("restored-1", (e) => events.push(e));

    await expect(sm.activateSession("restored-1")).rejects.toThrow(
      "replay exploded",
    );

    expect(configOptionEvents(events).map((e) => e.model)).toEqual([
      { supported: false, pending: false },
    ]);
  });

  it("a failed REactivation keeps the options it already knows", async () => {
    // The terminal snapshot terminates the WAIT, it does not claim the agent
    // offers no models. A session that was active, got evicted, and fails to
    // come back must keep its picker rather than have it collapse to hidden.
    const id = await sm.createSession();
    await sm.deactivateSession(id);

    const events: AgentEvent[] = [];
    sm.onEvent(id, (e) => events.push(e));
    mockConnection.loadSession.mockRejectedValue(new Error("replay exploded"));

    await expect(sm.activateSession(id)).rejects.toThrow("replay exploded");

    expect(configOptionEvents(events).map((e) => e.model)).toEqual([
      {
        supported: true,
        currentModelId: "claude-opus-4-8",
        availableModels: [
          { id: "claude-opus-4-8", name: "Opus 4.8", description: undefined },
          { id: "claude-sonnet-4-6", name: "Sonnet 4.6", description: undefined },
        ],
      },
    ]);
  });
});
