import { describe, it, expect, vi } from "vitest";
import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import { serverLogger } from "@/lib/logger";
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

  it("config_option_update replaces configOptions and emits agent-config-options", () => {
    // These arrive when a model (or any config) is changed from OUTSIDE libi —
    // or by libi's own pushModelToSession. They were explicitly discarded
    // ("Informational updates — not surfaced to the UI"), so neither server
    // nor client ever learned about a change it did not itself initiate.
    const session = makeSession();
    const { handler, emit } = makeHandler(session);
    const configOptions = [
      {
        type: "select",
        id: "model",
        name: "Model",
        currentValue: "opus",
        options: [
          { value: "opus", name: "Opus" },
          { value: "haiku", name: "Haiku" },
        ],
      },
    ];
    handler.handleSessionUpdate("s1", {
      sessionId: "s1",
      update: { sessionUpdate: "config_option_update", configOptions },
    } as unknown as SessionNotification);

    // toEqual, not toHaveLength — a length check passes on "assigned
    // something else of the same length", which is exactly the mistake a
    // full-replacement assignment can make.
    expect(session.configOptions).toEqual(configOptions);
    expect(emit).toHaveBeenCalledWith("s1", {
      type: "agent-config-options",
      model: {
        supported: true,
        currentModelId: "opus",
        availableModels: [
          { id: "opus", name: "Opus", description: undefined },
          { id: "haiku", name: "Haiku", description: undefined },
        ],
      },
    });
  });

  it("config_option_update for an unknown session routes to the orphan stash (standby pre-claim)", () => {
    // Same shape as the commands stash above: the standby session has no
    // SessionEntry until it is claimed, and dropping the update would hand
    // the claimed chat stale options.
    const emit = vi.fn();
    const stashConfig = vi.fn();
    const handler = new SessionEventHandler(
      { next: () => 1 },
      emit,
      () => undefined,
      undefined,
      stashConfig,
    );
    const configOptions = [
      { type: "select", id: "model", name: "Model", currentValue: "opus", options: [] },
    ];
    handler.handleSessionUpdate("standby-1", {
      sessionId: "standby-1",
      update: { sessionUpdate: "config_option_update", configOptions },
    } as unknown as SessionNotification);

    expect(stashConfig).toHaveBeenCalledWith("standby-1", configOptions);
    expect(emit).not.toHaveBeenCalled();
  });

  // Context compaction arrived with @agentclientprotocol/sdk 1.x. libi does not
  // surface it, and "does not surface" must mean SILENT rather than a fall
  // through to the exhaustiveness default, which logs `unknown_session_update`
  // once per chunk. No adapter can reach that today — these updates require
  // the client to have advertised `ClientSessionCapabilities::compaction` and
  // libi advertises `clientCapabilities: {}` — so this pins the DEFENSIVE
  // handling: it is what will already be right on the day libi advertises it.
  for (const update of [
    { sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" },
    {
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "c1",
      content: { type: "text", text: "…summary so far" },
    },
  ]) {
    it(`${update.sessionUpdate} is a silent no-op (no event, no unknown-update warning)`, () => {
      const session = makeSession();
      const { handler, emit } = makeHandler(session);
      // try/finally, not a trailing restore: this suite sets neither
      // `restoreMocks` nor `clearMocks`, so a failing assertion would skip the
      // restore and the spy would accumulate calls into the NEXT iteration —
      // turning one real failure into two, the second of them bogus.
      const warn = vi.spyOn(serverLogger, "warn").mockImplementation(() => {});
      try {
        handler.handleSessionUpdate("s1", {
          sessionId: "s1",
          update,
        } as unknown as SessionNotification);

        expect(emit).not.toHaveBeenCalled();
        expect(session.messageCache).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  }
});
