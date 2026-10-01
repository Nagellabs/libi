// __tests__/integration/session-replay-not-broadcast.test.ts
//
// Opening a chat the server has not loaded yet (every chat, after a server restart) runs
// `session/load`, and the adapter REPLAYS the transcript as ordinary `session/update`
// notifications. That replay builds the history `GET /api/agent/messages` returns — it is not a
// turn. Broadcast over the SSE as if it were, the open chat assembled it into a streaming message,
// and the history fetch that resolved next ADOPTED its last agent message as the in-flight turn
// (`applyHistory`), with no `agent-complete` ever coming: "PINEAPPLE ▍" on a chat whose last turn
// ended hours ago. The gate sits around the replay's own updates only
// (`SessionEventHandler.handleSessionUpdate`): a job's progress or its one-time orphaned-row result
// that lands during a load is not replay and still goes out. Real SessionEventHandler, stubbed
// connection and job manager.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/approval/settings", () => ({ getApprovalMode: vi.fn(() => "auto") }));
vi.mock("@/lib/sessions/model-preferences", () => ({
  getAgentModelId: vi.fn(() => null),
  setAgentModelId: vi.fn(),
}));
vi.mock("@/lib/mcp-config", () => ({
  getMcpServersForAcp: vi.fn(() => [{ type: "http", name: "libi", url: "http://x/mcp" }]),
  getMcpServersForAcpFallback: vi.fn(() => [{ type: "http", name: "libi-app", url: "http://x/mcp" }]),
  onMcpConfigInvalidated: vi.fn(),
}));
// The job manager the handler's bridge listens to: only its events matter here.
const fakeJobs = vi.hoisted(() => ({ mgr: null as unknown as import("node:events").EventEmitter }));
vi.mock("@/lib/jobs/manager", async () => {
  const { EventEmitter: EE } = await import("node:events");
  const mgr = Object.assign(new EE(), {
    attachToolCallId: vi.fn(),
    getStatus: vi.fn(async () => ({ kind: "x", startedAt: null, completedAt: null })),
  });
  fakeJobs.mgr = mgr;
  return { getJobManager: () => mgr };
});
vi.mock("@/lib/db/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/settings")>()),
  getNotificationsSetting: vi.fn(() => ({ backgroundJobComplete: false })),
}));

import { SessionManager } from "@/lib/sessions/session-manager";
import type { SessionEntry } from "@/lib/sessions/types";
import type { AgentEvent } from "@/lib/agents/types";
import type { AgentMessage } from "@/lib/agents/message-types";
import { jobProgressEmitter } from "@/lib/jobs/progress-emitter";
import type { ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import {
  applyAgentEvent,
  applyHistory,
  initialChatStreamState,
  selectChatMessages,
  type ChatStreamState,
} from "@/lib/chat/stream-state";

const SID = "chat-1";

function inactiveEntry(agentId = "claude-code"): SessionEntry {
  return {
    sessionId: SID,
    agentId,
    title: null,
    updatedAt: null,
    active: false,
    lastUsed: Date.now(),
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

const note = (update: SessionNotification["update"]): SessionNotification => ({ sessionId: SID, update });

/** The transcript the adapter replays: one finished exchange, plus the session's commands. */
const REPLAY: SessionNotification[] = [
  note({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Say PINEAPPLE" } }),
  note({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "easy" } }),
  note({
    sessionUpdate: "tool_call",
    toolCallId: "tc-1",
    title: "Read",
    kind: "read",
    status: "completed",
    rawInput: { file_path: "/tmp/x" },
  }),
  note({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PINEAPPLE" } }),
  note({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "c" }] }),
];

const CONTENT_TYPES = [
  "agent-text",
  "agent-tool-call",
  "agent-tool-result",
  "agent-tool-status",
  "agent-tool-args",
  "agent-tool-title",
  "agent-tool-progress",
  "agent-subagent-refine",
];

/** A chat view as use-agent-chat runs it: every SSE event applied as it arrives. */
function openView(sm: SessionManager, initial: ChatStreamState = initialChatStreamState()) {
  const view = { state: initial };
  sm.onGlobalEvent((sessionId, event) => {
    if (sessionId === SID) view.state = applyAgentEvent(view.state, event).state;
  });
  return view;
}

describe("SessionManager — a history replay is not broadcast as a live turn", () => {
  let sm: SessionManager;
  let sse: AgentEvent[];
  let entry: SessionEntry;
  /** What the adapter does on `session/load`; replaced per test. */
  let onLoad: (params: { mcpServers: { name: string }[] }) => Promise<unknown>;
  let loadSession: ReturnType<typeof vi.fn>;
  const replay = (ns: SessionNotification[]) => {
    for (const n of ns) sm.getEventHandler().handleSessionUpdate(SID, n);
  };

  function build(agentId = "claude-code") {
    sm = new SessionManager();
    loadSession = vi.fn((params: { mcpServers: { name: string }[] }) => onLoad(params));
    sm.setProcessManager({
      getConnection: vi.fn(
        () =>
          ({
            loadSession,
            setSessionMode: vi.fn().mockResolvedValue(undefined),
            cancel: vi.fn().mockResolvedValue(undefined),
            closeSession: vi.fn().mockResolvedValue(undefined),
          }) as unknown as ClientSideConnection,
      ),
      warmProcess: vi.fn(async () => {}),
      getCapabilitiesForAgent: vi.fn(() => ({ canListSessions: true })),
      registerSessionId: vi.fn(),
      unregisterSessionId: vi.fn(),
    });
    entry = inactiveEntry(agentId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sessions.set(SID, entry);
    sse = [];
    sm.onGlobalEvent((sessionId, event) => {
      if (sessionId === SID) sse.push(event);
    });
  }

  beforeEach(() => {
    // As the adapter does: every notification of the transcript before the load answers.
    onLoad = async () => {
      replay(REPLAY);
      return {};
    };
    build();
  });
  afterEach(() => {
    vi.useRealTimers();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm.getEventHandler() as any).detachJobProgress?.();
  });

  const agentText = (history: AgentMessage[]) =>
    history
      .filter((m) => m.role === "agent")
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("");

  it("builds the history from the replay but sends none of its message content over the SSE", async () => {
    const history = await sm.activateSession(SID);

    expect(agentText(history)).toBe("PINEAPPLE");
    const types = sse.map((e) => e.type);
    for (const t of CONTENT_TYPES) expect(types).not.toContain(t);
    // Session context is not history: the composer's command palette still hears about it.
    expect(types).toContain("agent-commands");
    // And the activation's own status frames still bracket the load.
    expect(types[0]).toBe("agent-status");
    expect(sse.at(-1)).toEqual({ type: "agent-status", status: "connected" });
  });

  it("an open chat that receives the SSE while its history fetch is in flight ends with nothing streaming", async () => {
    const view = openView(sm);
    const history = await sm.activateSession(SID);
    view.state = applyHistory(view.state, history);

    expect(selectChatMessages(view.state).some((m) => m.isStreaming)).toBe(false);
    expect(view.state.currentAgentMessageId).toBeNull();
  });

  it("content that arrives after the replay (a live turn) is still broadcast", async () => {
    await sm.activateSession(SID);
    sse.length = 0;
    replay([note({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "live" } })]);
    expect(sse).toContainEqual({ type: "agent-text", text: "live" });
  });

  it("a replay that fails leaks nothing, answers with the error status, and clears the flag", async () => {
    onLoad = async () => {
      replay(REPLAY.slice(0, 4));
      throw new Error("adapter fell over mid-replay");
    };

    await expect(sm.activateSession(SID)).rejects.toThrow("adapter fell over mid-replay");

    const types = sse.map((e) => e.type);
    for (const t of CONTENT_TYPES) expect(types).not.toContain(t);
    expect(sse).toContainEqual({ type: "agent-status", status: "error", error: "adapter fell over mid-replay" });
    expect(entry.messageCache).toEqual([]);
    expect(entry.isReplaying).toBe(false);
    // Cleared for real: the next update for this session is live again.
    sse.length = 0;
    replay([note({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after" } })]);
    expect(sse).toContainEqual({ type: "agent-text", text: "after" });
  });

  it("the Codex MCP-entry fallback: neither the refused attempt's replay nor the retry's is broadcast", async () => {
    build("codex");
    onLoad = async ({ mcpServers }) => {
      if (mcpServers.some((m) => m.name === "libi")) {
        // What the refused attempt managed to replay before codex rejected the config.
        replay(REPLAY.slice(0, 3));
        throw {
          code: -32603,
          message: "Internal error",
          data: "failed to load configuration: url is not supported for stdio\nin `mcp_servers.libi`",
        };
      }
      replay(REPLAY);
      // codex-acp 1.10.0 answers `session/load` with the session's modes.
      return {
        modes: {
          currentModeId: "agent",
          availableModes: [{ id: "read-only" }, { id: "agent" }, { id: "agent-full-access" }],
        },
      };
    };

    const history = await sm.activateSession(SID);

    expect(loadSession).toHaveBeenCalledTimes(2);
    expect(agentText(history)).toBe("PINEAPPLE");
    const types = sse.map((e) => e.type);
    for (const t of CONTENT_TYPES) expect(types).not.toContain(t);
    expect(sse.at(-1)).toEqual({ type: "agent-status", status: "connected" });
    expect(entry.isReplaying).toBe(false);
  });

  it("an already-active chat opened mid-turn still streams: no replay, and the history fetch adopts the turn", async () => {
    await sm.activateSession(SID); // loaded earlier
    entry.promptsInFlight = 1; // a turn is running
    const view = openView(sm);

    // The turn keeps talking while the chat's history fetch is in flight…
    replay([note({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still going" } })]);
    const history = await sm.activateSession(SID);
    view.state = applyHistory(view.state, history);

    expect(loadSession).toHaveBeenCalledTimes(1); // no second load, so nothing replayed
    const shown = selectChatMessages(view.state);
    expect(shown.at(-1)?.isStreaming).toBe(true);
    expect(view.state.currentAgentMessageId).toBe(shown.at(-1)?.id);
    expect(agentText(shown)).toContain("still going");
  });

  it("a job that ticks and ends during a load still updates the open chat (not replay)", async () => {
    // The chat is open with its history; a job's tool call never got its result.
    const jobCall = note({
      sessionUpdate: "tool_call",
      toolCallId: "tc-job",
      title: "mcp__libi__music_download_model",
      kind: "other",
      status: "in_progress",
      rawInput: {},
    });
    onLoad = async () => {
      replay([...REPLAY, jobCall]);
      return {};
    };
    const view = openView(sm);
    view.state = applyHistory(view.state, await sm.activateSession(SID));

    // It is loaded again (an agent-asked restart, an LRU reload) — no history refetch follows —
    // and the job ticks and ends while that replay is running.
    entry.active = false;
    onLoad = async () => {
      replay([...REPLAY, jobCall]);
      jobProgressEmitter.emit("job_progress", {
        jobId: "j1",
        toolCallId: "tc-job",
        kind: "music_download_model",
        done: 6,
        total: 12,
        unit: "MB",
        etaMs: null,
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      fakeJobs.mgr.emit("completed", { jobId: "j1", toolCallIds: ["tc-job"] });
      vi.advanceTimersByTime(10_000); // past the finalizer's grace
      vi.useRealTimers();
      return {};
    };
    sse.length = 0;
    await sm.activateSession(SID);

    expect(sse.map((e) => e.type)).toContain("agent-tool-progress");
    expect(sse).toContainEqual(expect.objectContaining({ type: "agent-tool-result", toolCallId: "tc-job" }));
    const row = selectChatMessages(view.state)
      .flatMap((m) => m.parts)
      .find((p) => p.type === "tool-result" && p.toolCallId === "tc-job");
    expect(row).toMatchObject({ result: "Finished in the background.", success: true });
    // …and the replayed content of that same load still stayed home.
    expect(sse.map((e) => e.type)).not.toContain("agent-text");
    expect(sse.map((e) => e.type)).not.toContain("agent-tool-call");
  });
});
