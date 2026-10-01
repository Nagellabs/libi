import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionNotification, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { SessionEntry } from "@/lib/sessions/types";

// codexMaxWindowFor is Codex's private-cache reader (lib/agents/codex-model-windows.ts,
// CW-1) — stubbed so this test never touches a real ~/.codex.
const codexMaxWindowFor = vi.fn<(modelId: string) => number | null>();
vi.mock("@/lib/agents/codex-model-windows", () => ({
  codexMaxWindowFor: (modelId: string) => codexMaxWindowFor(modelId),
}));

const { SessionEventHandler } = await import("@/lib/agents/session-event-handler");

function modelConfigOptions(currentValue: string): SessionConfigOption[] {
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      currentValue,
      options: [{ value: currentValue, name: currentValue }],
    },
  ] as unknown as SessionConfigOption[];
}

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "s1",
    agentId: "codex",
    title: null,
    updatedAt: null,
    active: true,
    lastUsed: 0,
    messageCache: [],
    currentAgentMessage: null,
    currentUserMessage: null,
    listeners: new Set(),
    pendingApprovals: new Map(),
    configOptions: [],
    latestUsage: null,
    availableCommands: [],
    ...overrides,
  } as SessionEntry;
}

function makeHandler(session: SessionEntry) {
  const emit = vi.fn();
  const handler = new SessionEventHandler({ next: () => 1 }, emit, () => session);
  return { handler, emit };
}

beforeEach(() => {
  codexMaxWindowFor.mockReset();
});

describe("usage_update maxSize (CW-1: Codex's larger supported window)", () => {
  it("codex usage with a known max greater than size sets maxSize", () => {
    codexMaxWindowFor.mockReturnValue(872_000);
    const session = makeSession({ configOptions: modelConfigOptions("gpt-6-sol") });
    const { handler } = makeHandler(session);

    handler.handleSessionUpdate("s1", {
      sessionId: "s1",
      update: { sessionUpdate: "usage_update", used: 20_000, size: 258_400 },
    } as unknown as SessionNotification);

    expect(session.latestUsage?.size).toBe(258_400);
    expect(session.latestUsage?.maxSize).toBe(872_000);
    expect(codexMaxWindowFor).toHaveBeenCalledWith("gpt-6-sol");
  });

  it("codex usage whose known max is not greater than size leaves maxSize null", () => {
    codexMaxWindowFor.mockReturnValue(200_000);
    const session = makeSession({ configOptions: modelConfigOptions("gpt-5.5") });
    const { handler } = makeHandler(session);

    handler.handleSessionUpdate("s1", {
      sessionId: "s1",
      update: { sessionUpdate: "usage_update", used: 20_000, size: 272_000 },
    } as unknown as SessionNotification);

    expect(session.latestUsage?.maxSize).toBeNull();
  });

  it("codex usage for a model with no known max leaves maxSize null", () => {
    codexMaxWindowFor.mockReturnValue(null);
    const session = makeSession({ configOptions: modelConfigOptions("gpt-9-unknown") });
    const { handler } = makeHandler(session);

    handler.handleSessionUpdate("s1", {
      sessionId: "s1",
      update: { sessionUpdate: "usage_update", used: 20_000, size: 200_000 },
    } as unknown as SessionNotification);

    expect(session.latestUsage?.maxSize).toBeNull();
  });

  it("claude sessions never get maxSize, even with a matching model id", () => {
    codexMaxWindowFor.mockReturnValue(872_000);
    const session = makeSession({
      agentId: "claude-code",
      configOptions: modelConfigOptions("gpt-6-sol"),
    });
    const { handler } = makeHandler(session);

    handler.handleSessionUpdate("s1", {
      sessionId: "s1",
      update: { sessionUpdate: "usage_update", used: 20_000, size: 200_000 },
    } as unknown as SessionNotification);

    expect(session.latestUsage?.maxSize).toBeNull();
    expect(codexMaxWindowFor).not.toHaveBeenCalled();
  });
});
