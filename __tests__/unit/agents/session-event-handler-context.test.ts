import { describe, it, expect, vi } from "vitest";
import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import type { SessionEntry } from "@/lib/sessions/types";
import type { SessionNotification } from "@agentclientprotocol/sdk";

function makeSession(): SessionEntry {
  return {
    sessionId: "s1",
    agentId: "claude-code",
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
  };
}

function makeHandler(session: SessionEntry) {
  const emit = vi.fn();
  const handler = new SessionEventHandler(
    { next: () => 1 },
    emit,
    () => session,
  );
  return { handler, emit };
}

describe("SessionEventHandler context updates", () => {
  it("usage_update stashes SessionUsageState and emits agent-usage", () => {
    const session = makeSession();
    const { handler, emit } = makeHandler(session);
    handler.handleSessionUpdate("s1", {
      sessionId: "s1",
      update: { sessionUpdate: "usage_update", used: 82_000, size: 200_000 },
    } as unknown as SessionNotification);

    expect(session.latestUsage?.used).toBe(82_000);
    expect(session.latestUsage?.size).toBe(200_000);
    expect(emit).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "agent-usage" }),
    );
  });

  it("malformed usage_update neither stashes nor emits", () => {
    const session = makeSession();
    const { handler, emit } = makeHandler(session);
    handler.handleSessionUpdate("s1", {
      sessionId: "s1",
      update: { sessionUpdate: "usage_update", used: "many", size: 200_000 },
    } as unknown as SessionNotification);

    expect(session.latestUsage).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it("available_commands_update stashes commands and emits agent-commands", () => {
    const session = makeSession();
    const { handler, emit } = makeHandler(session);
    handler.handleSessionUpdate("s1", {
      sessionId: "s1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "compact", description: "Compact the conversation" },
        ],
      },
    } as unknown as SessionNotification);

    expect(session.availableCommands).toEqual([
      { name: "compact", description: "Compact the conversation", inputHint: null },
    ]);
    expect(emit).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "agent-commands" }),
    );
  });

  it("works during history replay too (isReplaying)", () => {
    const session = { ...makeSession(), isReplaying: true };
    const { handler, emit } = makeHandler(session);
    handler.handleSessionUpdate("s1", {
      sessionId: "s1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "model", description: "" }],
      },
    } as unknown as SessionNotification);
    expect(session.availableCommands).toHaveLength(1);
    expect(emit).toHaveBeenCalled();
  });

  it("commands for an unknown session route to the orphan stash (standby pre-claim)", () => {
    // claude-agent-acp advertises commands ~0ms after newSession() returns;
    // for the standby session no SessionEntry exists yet — the update must
    // reach the stash callback instead of being dropped (QA 2026-07-04:
    // every standby-claimed chat had an empty palette).
    const emit = vi.fn();
    const stash = vi.fn();
    const handler = new SessionEventHandler(
      { next: () => 1 },
      emit,
      () => undefined,
      stash,
    );
    handler.handleSessionUpdate("standby-1", {
      sessionId: "standby-1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "compact", description: "Compact the conversation" },
        ],
      },
    } as unknown as SessionNotification);

    expect(stash).toHaveBeenCalledWith("standby-1", [
      { name: "compact", description: "Compact the conversation", inputHint: null },
    ]);
    expect(emit).not.toHaveBeenCalled();
  });
});
