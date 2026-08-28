import { vi, describe, it, expect, beforeEach } from "vitest";
import type { AgentEvent } from "@/lib/agents/types";
import type { McpToolId } from "@/lib/agents/mcp-tool-id";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("@/lib/libi-home", () => ({
  getLibiAgentDir: vi.fn(() => "/tmp/libi-test-agent"),
  // Reached via `signInRemedyFor` → `getAgentInstallRoot()` when an auth
  // failure is recorded on the prompt path.
  getLibiHome: vi.fn(() => "/tmp/libi-test-home"),
  // Required by lib/logger (imported transitively via session-manager)
  ensureLibiDirs: vi.fn(),
  getLibiLogDir: vi.fn(() => "/tmp/libi-test-logs"),
}));

vi.mock("@/lib/mcp-config", () => ({
  getMcpServersForAcp: vi.fn(() => []),
  onMcpConfigInvalidated: vi.fn(),
}));

// Stub approval-mode reader so we don't hit the settings DB (and the
// transitive `getLibiDbPath` import that's not in our libi-home mock).
vi.mock("@/lib/approval/settings", () => ({
  getApprovalMode: vi.fn(() => "auto"),
}));

// No saved model preference in these tests — pushModelToSession no-ops early
// (before any settings-DB access), so session lifecycle behaviour is unchanged.
vi.mock("@/lib/sessions/model-preferences", () => ({
  getAgentModelId: vi.fn(() => null),
  setAgentModelId: vi.fn(),
}));

// Mock the SessionEventHandler (loaded lazily via require() inside SessionManager)
const mockCleanUserMessageParts = vi.fn();

vi.mock("@/lib/agents/session-event-handler", () => ({
  SessionEventHandler: vi.fn().mockImplementation(() => ({
    createClient: vi.fn().mockReturnValue({}),
    cleanUserMessageParts: mockCleanUserMessageParts,
  })),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { SessionManager } from "@/lib/sessions/session-manager";
import { MAX_ACTIVE_SESSIONS } from "@/lib/sessions/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockPm() {
  const mockConnection = {
    listSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
    newSession: vi.fn().mockResolvedValue({ sessionId: "new-session-1" }),
    loadSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    setSessionMode: vi.fn().mockResolvedValue(undefined),
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

function createSessionManager(pm?: ReturnType<typeof createMockPm>["pm"]) {
  const sm = new SessionManager();
  if (pm) sm.setProcessManager(pm);
  return sm;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionManager", () => {
  let sm: SessionManager;
  let pm: ReturnType<typeof createMockPm>["pm"];
  let mockConnection: ReturnType<typeof createMockPm>["mockConnection"];

  beforeEach(() => {
    vi.clearAllMocks();
    const mocks = createMockPm();
    pm = mocks.pm;
    mockConnection = mocks.mockConnection;
    sm = createSessionManager(pm);
  });

  // -------------------------------------------------------------------------
  // loadInitialSessions
  // -------------------------------------------------------------------------

  describe("loadInitialSessions", () => {
    it("loads sessions from ACP and stores them as inactive entries", async () => {
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [
          { sessionId: "s1", title: "First", updatedAt: "2026-04-10T12:00:00Z" },
          { sessionId: "s2", title: "Second", updatedAt: "2026-04-11T12:00:00Z" },
        ],
        nextCursor: null,
      });

      await sm.loadInitialSessions("claude-code");

      const all = sm.getAllSessions();
      expect(all).toHaveLength(2);
      expect(all.every((s) => s.active === false)).toBe(true);

      const ids = all.map((s) => s.sessionId).sort();
      expect(ids).toEqual(["s1", "s2"]);

      const s1 = all.find((s) => s.sessionId === "s1")!;
      expect(s1.title).toBe("First");
    });

    it("paginates through multiple pages", async () => {
      mockConnection.listSessions
        .mockResolvedValueOnce({
          sessions: [{ sessionId: "s1", title: "Page 1", updatedAt: null }],
          nextCursor: "cursor-1",
        })
        .mockResolvedValueOnce({
          sessions: [{ sessionId: "s2", title: "Page 2", updatedAt: null }],
          nextCursor: null,
        });

      await sm.loadInitialSessions("claude-code");

      expect(sm.getAllSessions()).toHaveLength(2);
      expect(mockConnection.listSessions).toHaveBeenCalledTimes(2);
    });

    it("does not overwrite existing sessions", async () => {
      mockConnection.listSessions.mockResolvedValue({
        sessions: [{ sessionId: "s1", title: "Original", updatedAt: null }],
        nextCursor: null,
      });

      await sm.loadInitialSessions("claude-code");
      // Modify the title to check it's not overwritten
      const original = sm.getSession("s1")!;
      expect(original.title).toBe("Original");

      mockConnection.listSessions.mockResolvedValue({
        sessions: [{ sessionId: "s1", title: "Updated", updatedAt: null }],
        nextCursor: null,
      });

      await sm.loadInitialSessions("claude-code");
      // Should still be "Original" because loadInitialSessions skips existing
      expect(sm.getSession("s1")!.title).toBe("Original");
    });

    it("does nothing when process manager is not set", async () => {
      const bare = new SessionManager();
      await bare.loadInitialSessions("claude-code");

      expect(bare.getAllSessions()).toHaveLength(0);
    });

    it("does nothing when agent cannot list sessions", async () => {
      pm.getCapabilitiesForAgent.mockReturnValue({ canListSessions: false });

      await sm.loadInitialSessions("claude-code");

      expect(mockConnection.listSessions).not.toHaveBeenCalled();
      expect(sm.getAllSessions()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // createSession
  // -------------------------------------------------------------------------

  describe("createSession", () => {
    it("throws when no active agent is set", async () => {
      const bare = createSessionManager(pm);
      await expect(bare.createSession()).rejects.toThrow(
        "No active agent"
      );
    });

    it("creates a session via ACP newSession when no standby exists", async () => {
      // Set active agent without loading sessions (to skip standby creation)
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "fresh-1",
      });

      const sessionId = await sm.createSession();

      expect(sessionId).toBe("fresh-1");
      expect(mockConnection.newSession).toHaveBeenCalledOnce();

      const entry = sm.getSession("fresh-1")!;
      expect(entry.active).toBe(true);
      expect(entry.agentId).toBe("claude-code");
    });

    it("calls registerSessionId on the process manager", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "fresh-1",
      });

      await sm.createSession();

      expect(pm.registerSessionId).toHaveBeenCalledWith(
        "claude-code",
        "fresh-1"
      );
    });

    it("claims a standby session when available", async () => {
      await sm.loadInitialSessions("claude-code");

      // Create a standby
      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "standby-1",
      });
      await sm.createStandbySession();

      // Now createSession should claim the standby
      // Next newSession call would return a different id for the replenished standby
      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "standby-2",
      });

      const sessionId = await sm.createSession();

      expect(sessionId).toBe("standby-1");

      const entry = sm.getSession("standby-1")!;
      expect(entry.active).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // approval-mode ACP push (per-agent vocabulary — G8 codex -32602 fix)
  // -------------------------------------------------------------------------

  describe("approval-mode ACP push", () => {
    // getApprovalMode is stubbed to "auto" (see top-of-file mock).

    it("pushes bypassPermissions to claude-code when advertised", async () => {
      await sm.loadInitialSessions("claude-code");
      mockConnection.setSessionMode = vi.fn().mockResolvedValue(undefined);
      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "cc-1",
        modes: {
          availableModes: [{ id: "default" }, { id: "bypassPermissions" }],
        },
      });

      await sm.createSession();

      expect(mockConnection.setSessionMode).toHaveBeenCalledWith({
        sessionId: "cc-1",
        modeId: "bypassPermissions",
      });
    });

    it("pushes full-access (NOT bypassPermissions) to codex", async () => {
      await sm.loadInitialSessions("codex");
      mockConnection.setSessionMode = vi.fn().mockResolvedValue(undefined);
      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "cx-1",
        modes: {
          availableModes: [
            { id: "read-only" },
            { id: "auto" },
            { id: "full-access" },
          ],
        },
      });

      await sm.createSession();

      expect(mockConnection.setSessionMode).toHaveBeenCalledWith({
        sessionId: "cx-1",
        modeId: "full-access",
      });
      // The whole point of the fix: codex must never be handed Claude's id.
      for (const call of mockConnection.setSessionMode.mock.calls) {
        expect(call[0].modeId).not.toBe("bypassPermissions");
      }
    });

    it("skips the push (no setSessionMode call) when the target isn't advertised", async () => {
      await sm.loadInitialSessions("codex");
      mockConnection.setSessionMode = vi.fn().mockResolvedValue(undefined);
      // full-access absent → cannot push blind → -32602 avoided.
      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "cx-restricted",
        modes: { availableModes: [{ id: "read-only" }, { id: "auto" }] },
      });

      await sm.createSession();

      expect(mockConnection.setSessionMode).not.toHaveBeenCalled();
    });

    it("uses the CACHED advertised modes on a user-driven broadcast", async () => {
      await sm.loadInitialSessions("codex");
      mockConnection.setSessionMode = vi.fn().mockResolvedValue(undefined);
      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "cx-broadcast",
        modes: {
          availableModes: [
            { id: "read-only" },
            { id: "auto" },
            { id: "full-access" },
          ],
        },
      });
      await sm.createSession();
      mockConnection.setSessionMode.mockClear();

      // The broadcast passes availableModes: undefined; it must fall back to
      // the cached set and still resolve full-access (never push blind).
      await sm.applyApprovalModeToActiveSessions("codex");

      expect(mockConnection.setSessionMode).toHaveBeenCalledWith({
        sessionId: "cx-broadcast",
        modeId: "full-access",
      });
    });
  });

  // -------------------------------------------------------------------------
  // activateSession
  // -------------------------------------------------------------------------

  describe("activateSession", () => {
    it("throws for unknown session", async () => {
      await expect(sm.activateSession("nonexistent")).rejects.toThrow(
        "not found"
      );
    });

    it("returns existing cache for already active session", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "active-1",
      });

      const sessionId = await sm.createSession();
      const messages = await sm.activateSession(sessionId);

      // Already active, should return cache directly (which is empty for a new session)
      expect(messages).toEqual([]);
    });

    it("activates an inactive session via loadSession", async () => {
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [
          { sessionId: "old-1", title: "Old Session", updatedAt: null },
        ],
        nextCursor: null,
      });

      await sm.loadInitialSessions("claude-code");

      // old-1 should be inactive
      expect(sm.hasActiveSession("old-1")).toBe(false);

      const messages = await sm.activateSession("old-1");

      expect(sm.hasActiveSession("old-1")).toBe(true);
      expect(mockConnection.loadSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "old-1" })
      );
      expect(pm.registerSessionId).toHaveBeenCalledWith("claude-code", "old-1");
      expect(messages).toEqual([]); // Fresh cache after replay
    });
  });

  // -------------------------------------------------------------------------
  // deactivateSession
  // -------------------------------------------------------------------------

  describe("deactivateSession", () => {
    it("marks an active session as inactive", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "deact-1",
      });
      const sessionId = await sm.createSession();

      expect(sm.hasActiveSession(sessionId)).toBe(true);

      await sm.deactivateSession(sessionId);

      expect(sm.hasActiveSession(sessionId)).toBe(false);
    });

    it("calls unregisterSessionId on process manager", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "deact-1",
      });
      const sessionId = await sm.createSession();
      await sm.deactivateSession(sessionId);

      expect(pm.unregisterSessionId).toHaveBeenCalledWith(
        "claude-code",
        "deact-1"
      );
    });

    it("calls closeSession on the connection", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "deact-1",
      });
      const sessionId = await sm.createSession();
      await sm.deactivateSession(sessionId);

      expect(mockConnection.closeSession).toHaveBeenCalledWith({
        sessionId: "deact-1",
      });
    });

    it("preserves listeners as pending for reactivation", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "deact-1",
      });
      const sessionId = await sm.createSession();

      const events: AgentEvent[] = [];
      const cb = (e: AgentEvent) => events.push(e);
      sm.onEvent(sessionId, cb);

      await sm.deactivateSession(sessionId);

      // Emit to the deactivated session — should still reach pending listener
      sm.emitForSession(sessionId, { type: "agent-status", status: "test" });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "agent-status", status: "test" });
    });

    it("clears message cache on deactivation", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "deact-1",
      });
      const sessionId = await sm.createSession();

      // Manually add to cache to verify it's cleared
      const entry = sm.getSession(sessionId)!;
      entry.messageCache.push({
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
        timestamp: Date.now(),
      });

      await sm.deactivateSession(sessionId);

      expect(sm.getMessageCache(sessionId)).toEqual([]);
    });

    it("is a no-op for unknown session", async () => {
      // Should not throw
      await sm.deactivateSession("nonexistent");
    });

    it("is a no-op for already inactive session", async () => {
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [
          { sessionId: "inactive-1", title: "Inactive", updatedAt: null },
        ],
        nextCursor: null,
      });

      await sm.loadInitialSessions("claude-code");

      // Already inactive, should not call closeSession
      await sm.deactivateSession("inactive-1");

      expect(mockConnection.closeSession).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // sendMessage
  // -------------------------------------------------------------------------

  describe("sendMessage", () => {
    it("adds user and agent messages to cache", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "msg-1",
      });
      const sessionId = await sm.createSession();

      await sm.sendMessage(sessionId, "hello");

      const cache = sm.getMessageCache(sessionId);
      expect(cache.length).toBeGreaterThanOrEqual(2);

      const userMsg = cache.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.parts[0]).toEqual({ type: "text", text: "hello" });

      const agentMsg = cache.find((m) => m.role === "agent");
      expect(agentMsg).toBeDefined();
    });

    it("emits thinking status", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "msg-1",
      });
      const sessionId = await sm.createSession();

      const events: AgentEvent[] = [];
      sm.onEvent(sessionId, (e) => events.push(e));

      await sm.sendMessage(sessionId, "hello");

      const thinkingEvent = events.find(
        (e) => e.type === "agent-status" && e.status === "thinking"
      );
      expect(thinkingEvent).toBeDefined();
    });

    /**
     * The chat client keeps only the STATUS from `agent-status` and drops the
     * `error` text, so an unauthenticated Claude Code user would watch their
     * message vanish into nothing. Availability deliberately does not gate on
     * credentials (see lib/agents/acp/agent-registry.ts#detectClaudeCode), so
     * this note is the channel that reaches them.
     */
    it("posts an actionable chat-note when the prompt fails with ACP auth-required", async () => {
      await sm.loadInitialSessions("claude-code");
      mockConnection.newSession.mockResolvedValueOnce({ sessionId: "auth-1" });
      const sessionId = await sm.createSession();

      mockConnection.prompt.mockRejectedValueOnce(
        Object.assign(new Error("Authentication required"), { code: -32000 }),
      );

      const events: AgentEvent[] = [];
      sm.onEvent(sessionId, (e) => events.push(e));

      await sm.sendMessage(sessionId, "hello");

      expect(
        events.find((e) => e.type === "agent-status" && e.status === "error"),
      ).toBeDefined();
      const note = events.find((e) => e.type === "chat-note");
      expect(note).toBeDefined();
      expect((note as { text: string }).text.toLowerCase()).toContain("signed in");
    });

    it("posts no chat-note for an ordinary prompt failure", async () => {
      await sm.loadInitialSessions("claude-code");
      mockConnection.newSession.mockResolvedValueOnce({ sessionId: "auth-2" });
      const sessionId = await sm.createSession();

      mockConnection.prompt.mockRejectedValueOnce(new Error("Connection closed"));

      const events: AgentEvent[] = [];
      sm.onEvent(sessionId, (e) => events.push(e));

      await sm.sendMessage(sessionId, "hello");

      expect(
        events.find((e) => e.type === "agent-status" && e.status === "error"),
      ).toBeDefined();
      expect(events.find((e) => e.type === "chat-note")).toBeUndefined();
    });

    it("emits error for non-existent session", async () => {
      const events: AgentEvent[] = [];
      sm.onEvent("nonexistent", (e) => events.push(e));

      await sm.sendMessage("nonexistent", "hello");

      const errorEvent = events.find(
        (e) => e.type === "agent-status" && e.status === "error"
      );
      expect(errorEvent).toBeDefined();
    });

    it("emits error when prompt throws", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "msg-err",
      });
      const sessionId = await sm.createSession();

      const events: AgentEvent[] = [];
      sm.onEvent(sessionId, (e) => events.push(e));

      mockConnection.prompt.mockRejectedValueOnce(
        new Error("model overloaded")
      );

      await sm.sendMessage(sessionId, "hello");

      const errorEvent = events.find(
        (e) => e.type === "agent-status" && e.status === "error"
      );
      expect(errorEvent).toBeDefined();
      expect((errorEvent as { error?: string }).error).toBe("model overloaded");
    });

    it("passes raw text to conn.prompt", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "ctx-1",
      });
      const sessionId = await sm.createSession();

      await sm.sendMessage(sessionId, "first message");

      const firstPrompt = mockConnection.prompt.mock.calls[0][0];
      expect(firstPrompt.sessionId).toBe("ctx-1");
      expect(firstPrompt.prompt[0].text).toBe("first message");

      // Second message also passes raw text
      mockConnection.prompt.mockResolvedValueOnce({ stopReason: "end_turn" });
      await sm.sendMessage(sessionId, "second message");

      const secondPrompt = mockConnection.prompt.mock.calls[1][0];
      expect(secondPrompt.prompt[0].text).toBe("second message");
    });

    it("parses [Attached files] block into file-attachment parts on cached user message", async () => {
      // /api/agent/send appends a `[Attached files]` block to the user
      // text before calling sendMessage. The cache must mirror what the
      // LIVE client builds so a page refresh shows file chips, not raw
      // text. See session 108d13a5 — this regression made the chat panel
      // render the inline `[Attached files] - file.mp4 (… — fileId: …)`
      // line as plain text.
      await sm.loadInitialSessions("claude-code");
      mockConnection.newSession.mockResolvedValueOnce({ sessionId: "att-1" });
      const sessionId = await sm.createSession();

      const messageWithAttachments =
        "analyze the following video and suggest a duplicate script\n\n" +
        "[Attached files]\n" +
        "- WhatsApp Video.mp4 (video/mp4, 7.6 MB, 480x848, 49.6s) — fileId: bff4adda-f444-4a4c-ac70-7121b555d6fa";

      await sm.sendMessage(sessionId, messageWithAttachments);

      const cache = sm.getMessageCache(sessionId);
      const userMsg = cache.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();

      const textParts = userMsg!.parts.filter((p) => p.type === "text");
      const fileParts = userMsg!.parts.filter(
        (p) => p.type === "file-attachment",
      );
      expect(textParts).toHaveLength(1);
      expect((textParts[0] as { text: string }).text).toBe(
        "analyze the following video and suggest a duplicate script",
      );
      expect(fileParts).toHaveLength(1);
      const fp = fileParts[0] as {
        fileId: string;
        filename: string;
        contentType: string | null;
        size: number;
      };
      expect(fp.fileId).toBe("bff4adda-f444-4a4c-ac70-7121b555d6fa");
      expect(fp.filename).toBe("WhatsApp Video.mp4");
      expect(fp.contentType).toBe("video/mp4");
      expect(fp.size).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // postManualEditNote
  // -------------------------------------------------------------------------

  describe("postManualEditNote", () => {
    it("returns false and emits nothing when there is no active session", () => {
      const bare = new SessionManager();
      expect(bare.postManualEditNote("[manual edit] hi")).toBe(false);
    });

    it("emits a finished chat-note (no agent prompt) and returns true", async () => {
      await sm.loadInitialSessions("claude-code");
      mockConnection.newSession.mockResolvedValueOnce({ sessionId: "note-1" });
      const sessionId = await sm.createSession();

      const events: AgentEvent[] = [];
      sm.onEvent(sessionId, (e) => events.push(e));

      const ok = sm.postManualEditNote("[manual edit] Re-anchored at 0:17.");

      expect(ok).toBe(true);
      // conn.prompt must NOT be called — this is a non-prompting note.
      expect(mockConnection.prompt).not.toHaveBeenCalled();
      const note = events.find((e) => e.type === "chat-note");
      expect(note).toBeTruthy();
      expect(note).toMatchObject({
        type: "chat-note",
        text: "[manual edit] Re-anchored at 0:17.",
      });
      expect(typeof (note as { noteId: string }).noteId).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // LRU eviction
  // -------------------------------------------------------------------------

  describe("LRU eviction", () => {
    it("evicts the oldest active session when activating beyond MAX_ACTIVE_SESSIONS", async () => {
      await sm.loadInitialSessions("claude-code");

      // Create MAX_ACTIVE_SESSIONS active sessions
      const sessionIds: string[] = [];
      for (let i = 0; i < MAX_ACTIVE_SESSIONS; i++) {
        const id = `session-${i}`;
        mockConnection.newSession.mockResolvedValueOnce({ sessionId: id });
        await sm.createSession();
        sessionIds.push(id);

        // Stagger lastUsed times so we know which is oldest
        const entry = sm.getSession(id)!;
        entry.lastUsed = Date.now() - (MAX_ACTIVE_SESSIONS - i) * 1000;
      }

      // All should be active
      expect(sm.getActiveSessions()).toHaveLength(MAX_ACTIVE_SESSIONS);

      // Add one more inactive session to the map that we'll activate
      const extraSessionId = "extra-session";
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [
          { sessionId: extraSessionId, title: "Extra", updatedAt: null },
        ],
        nextCursor: null,
      });

      // We need to add the session to the map manually as inactive
      // Since loadInitialSessions skips existing, we use syncSessions
      await sm.syncSessions();

      // Now activate the extra session — this should evict the oldest
      await sm.activateSession(extraSessionId);

      // The oldest (session-0) should have been evicted
      expect(sm.hasActiveSession(sessionIds[0])).toBe(false);
      expect(sm.hasActiveSession(extraSessionId)).toBe(true);

      // Total active should still be MAX_ACTIVE_SESSIONS
      expect(sm.getActiveSessions()).toHaveLength(MAX_ACTIVE_SESSIONS);
    });

    /** Fill the manager to capacity with staggered `lastUsed` (session-0
     *  oldest), then add one inactive session ready to be activated. */
    async function fillToCapacity(): Promise<string[]> {
      await sm.loadInitialSessions("claude-code");

      const sessionIds: string[] = [];
      for (let i = 0; i < MAX_ACTIVE_SESSIONS; i++) {
        const id = `gen-session-${i}`;
        mockConnection.newSession.mockResolvedValueOnce({ sessionId: id });
        await sm.createSession();
        sessionIds.push(id);
        sm.getSession(id)!.lastUsed = Date.now() - (MAX_ACTIVE_SESSIONS - i) * 1000;
      }

      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [{ sessionId: "incoming", title: "Incoming", updatedAt: null }],
        nextCursor: null,
      });
      await sm.syncSessions();

      return sessionIds;
    }

    /** Mark a session as mid-turn the way `sendMessage` does. */
    function markGenerating(sessionId: string) {
      sm.getSession(sessionId)!.currentAgentMessage = {
        id: `agent_${sessionId}`,
        role: "agent",
        parts: [],
        timestamp: Date.now(),
      };
    }

    it("skips a generating session and evicts the next-oldest idle one", async () => {
      const sessionIds = await fillToCapacity();

      // The oldest is the prime LRU candidate precisely BECAUSE it is
      // generating: `lastUsed` is stamped at prompt time, so a long turn
      // ages while it works. Evicting it closes the ACP session and cancels
      // the in-flight prompt — silently destroying the work.
      markGenerating(sessionIds[0]);

      await sm.activateSession("incoming");

      expect(sm.hasActiveSession(sessionIds[0])).toBe(true);
      expect(sm.hasActiveSession(sessionIds[1])).toBe(false);
      expect(sm.hasActiveSession("incoming")).toBe(true);
      expect(sm.getActiveSessions()).toHaveLength(MAX_ACTIVE_SESSIONS);
    });

    it("evicts nobody when every candidate is generating", async () => {
      const sessionIds = await fillToCapacity();
      for (const id of sessionIds) markGenerating(id);

      await sm.activateSession("incoming");

      // Every generating session survives; the cap is exceeded by one rather
      // than cancelling someone's turn. The cap is a resource heuristic, not
      // a correctness constraint.
      for (const id of sessionIds) expect(sm.hasActiveSession(id)).toBe(true);
      expect(sm.hasActiveSession("incoming")).toBe(true);
      expect(sm.getActiveSessions()).toHaveLength(MAX_ACTIVE_SESSIONS + 1);
      expect(mockConnection.closeSession).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // switchAgent
  // -------------------------------------------------------------------------

  describe("switchAgent", () => {
    it("clears all sessions and loads from the new agent", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "old-session",
      });
      await sm.createSession();

      expect(sm.getAllSessions().length).toBeGreaterThan(0);

      // Switch to codex — listSessions will return new sessions
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [
          { sessionId: "codex-s1", title: "Codex Session", updatedAt: null },
        ],
        nextCursor: null,
      });

      await sm.switchAgent("codex");

      // Old sessions should be gone
      expect(sm.getSession("old-session")).toBeUndefined();

      // New agent sessions loaded
      const newSession = sm.getSession("codex-s1");
      expect(newSession).toBeDefined();
      expect(newSession!.agentId).toBe("codex");

      // Process should have been warmed
      expect(pm.warmProcess).toHaveBeenCalledWith("codex");
    });

    it("throws when process manager is not set", async () => {
      const bare = new SessionManager();
      await expect(bare.switchAgent("codex")).rejects.toThrow(
        "No process manager set"
      );
    });

    /**
     * The agent-switch stranding repro (released 0.1.0): switching away and
     * back re-lists the previous agent's sessions as INACTIVE while the chat
     * panel keeps displaying one of them. Every send then died with a 400
     * because nothing ever re-activated the displayed session. This test
     * pins the state the bug arises from AND the on-demand recovery
     * `/api/agent/send` now performs.
     */
    it("re-lists the previous agent's sessions as inactive after switching away and back, and on-demand activation revives them for sending", async () => {
      // A claude-code session, loaded and ACTIVE (the one on screen).
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [{ sessionId: "cc-old", title: "On screen", updatedAt: null }],
        nextCursor: null,
      });
      await sm.loadInitialSessions("claude-code");
      await sm.activateSession("cc-old");
      expect(sm.hasActiveSession("cc-old")).toBe(true);

      // Switch to codex (whether its standby succeeds is incidental to the
      // bug)…
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [],
        nextCursor: null,
      });
      await sm.switchAgent("codex");
      expect(sm.getSession("cc-old")).toBeUndefined();

      // …and back. The old session is re-listed but NOT re-activated.
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [{ sessionId: "cc-old", title: "On screen", updatedAt: null }],
        nextCursor: null,
      });
      await sm.switchAgent("claude-code");

      expect(sm.getSession("cc-old")).toBeDefined();
      expect(sm.hasActiveSession("cc-old")).toBe(false); // ← the stranded state

      // On-demand activation (what the send route does now) revives it…
      await sm.activateSession("cc-old");
      expect(sm.hasActiveSession("cc-old")).toBe(true);

      // …and a send reaches the agent instead of dying at the gate.
      await sm.sendMessage("cc-old", "hello again");
      expect(mockConnection.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "cc-old" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // handleProcessCrash
  // -------------------------------------------------------------------------

  describe("handleProcessCrash", () => {
    it("marks affected sessions as inactive and emits error events", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "crash-1",
      });
      const sessionId = await sm.createSession();

      const events: AgentEvent[] = [];
      sm.onEvent(sessionId, (e) => events.push(e));

      sm.handleProcessCrash("claude-code", "Process exited with code 1");

      expect(sm.hasActiveSession(sessionId)).toBe(false);

      const errorEvent = events.find(
        (e) => e.type === "agent-status" && e.status === "error"
      );
      expect(errorEvent).toBeDefined();
      expect((errorEvent as { error?: string }).error).toBe(
        "Process exited with code 1"
      );
    });

    it("does not affect sessions from a different agent", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "safe-1",
      });
      const sessionId = await sm.createSession();

      // Crash a different agent
      sm.handleProcessCrash("codex", "Codex crashed");

      expect(sm.hasActiveSession(sessionId)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Event routing
  // -------------------------------------------------------------------------

  describe("event routing", () => {
    it("emitForSession sends to session listeners", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "evt-1",
      });
      const sessionId = await sm.createSession();

      const events: AgentEvent[] = [];
      sm.onEvent(sessionId, (e) => events.push(e));

      sm.emitForSession(sessionId, { type: "agent-text", text: "hello" });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "agent-text", text: "hello" });
    });

    it("emitForSession sends to pending listeners", () => {
      const events: AgentEvent[] = [];
      sm.onEvent("future-session", (e) => events.push(e));

      sm.emitForSession("future-session", {
        type: "agent-status",
        status: "connected",
      });

      expect(events).toHaveLength(1);
    });

    it("emitForSession sends to global listeners", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "global-1",
      });
      const sessionId = await sm.createSession();

      const globalEvents: Array<{ sessionId: string; event: AgentEvent }> = [];
      sm.onGlobalEvent((sid, event) =>
        globalEvents.push({ sessionId: sid, event })
      );

      sm.emitForSession(sessionId, { type: "agent-text", text: "test" });

      expect(globalEvents).toHaveLength(1);
      expect(globalEvents[0].sessionId).toBe(sessionId);
    });

    it("offEvent stops delivering events", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "off-1",
      });
      const sessionId = await sm.createSession();

      const events: AgentEvent[] = [];
      const cb = (e: AgentEvent) => events.push(e);
      sm.onEvent(sessionId, cb);
      sm.offEvent(sessionId, cb);

      sm.emitForSession(sessionId, { type: "agent-text", text: "should not arrive" });

      expect(events).toHaveLength(0);
    });

    it("offGlobalEvent stops delivering global events", async () => {
      await sm.loadInitialSessions("claude-code");

      const events: Array<{ sessionId: string; event: AgentEvent }> = [];
      const cb = (sid: string, e: AgentEvent) =>
        events.push({ sessionId: sid, event: e });

      sm.onGlobalEvent(cb);
      sm.offGlobalEvent(cb);

      sm.emitForSession("any", { type: "agent-text", text: "test" });

      expect(events).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // syncSessions
  // -------------------------------------------------------------------------

  describe("syncSessions", () => {
    it("updates metadata for existing sessions", async () => {
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [
          { sessionId: "sync-1", title: "Original Title", updatedAt: null },
        ],
        nextCursor: null,
      });

      await sm.loadInitialSessions("claude-code");

      expect(sm.getSession("sync-1")!.title).toBe("Original Title");

      // Sync with updated metadata
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [
          {
            sessionId: "sync-1",
            title: "Updated Title",
            updatedAt: "2026-04-15T12:00:00Z",
          },
        ],
        nextCursor: null,
      });

      await sm.syncSessions();

      expect(sm.getSession("sync-1")!.title).toBe("Updated Title");
      expect(sm.getSession("sync-1")!.updatedAt).toBe(
        "2026-04-15T12:00:00Z"
      );
    });

    it("adds newly discovered sessions as inactive", async () => {
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [],
        nextCursor: null,
      });

      await sm.loadInitialSessions("claude-code");

      // Sync discovers a new session
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [
          { sessionId: "new-discovered", title: "New One", updatedAt: null },
        ],
        nextCursor: null,
      });

      await sm.syncSessions();

      const entry = sm.getSession("new-discovered");
      expect(entry).toBeDefined();
      expect(entry!.active).toBe(false);
      expect(entry!.title).toBe("New One");
    });

    it("does not remove sessions that vanished from ACP", async () => {
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [
          { sessionId: "will-vanish", title: "Will Vanish", updatedAt: null },
        ],
        nextCursor: null,
      });

      await sm.loadInitialSessions("claude-code");

      // Sync with empty response
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [],
        nextCursor: null,
      });

      await sm.syncSessions();

      // Should still be in the map
      expect(sm.getSession("will-vanish")).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // stripContextPrefix (tested via loaded sessions with prefixed titles)
  // -------------------------------------------------------------------------

  describe("stripContextPrefix", () => {
    it("strips [Context: ...] prefix from session titles", async () => {
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [
          {
            sessionId: "ctx-1",
            title: "[Context: session id=abc] Actual Title",
            updatedAt: null,
          },
        ],
        nextCursor: null,
      });

      await sm.loadInitialSessions("claude-code");

      expect(sm.getSession("ctx-1")!.title).toBe("Actual Title");
    });

    it("preserves titles without [Context:] prefix", async () => {
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [
          { sessionId: "no-ctx", title: "Regular Title", updatedAt: null },
        ],
        nextCursor: null,
      });

      await sm.loadInitialSessions("claude-code");

      expect(sm.getSession("no-ctx")!.title).toBe("Regular Title");
    });

    it("returns null for null titles", async () => {
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [
          { sessionId: "null-title", title: null, updatedAt: null },
        ],
        nextCursor: null,
      });

      await sm.loadInitialSessions("claude-code");

      expect(sm.getSession("null-title")!.title).toBeNull();
    });

    it("returns null when stripping leaves an empty string", async () => {
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [
          { sessionId: "empty-after", title: "[Context: id=abc]", updatedAt: null },
        ],
        nextCursor: null,
      });

      await sm.loadInitialSessions("claude-code");

      expect(sm.getSession("empty-after")!.title).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  describe("query helpers", () => {
    beforeEach(async () => {
      mockConnection.listSessions.mockResolvedValueOnce({
        sessions: [
          { sessionId: "q1", title: "Query 1", updatedAt: null },
          { sessionId: "q2", title: "Query 2", updatedAt: null },
        ],
        nextCursor: null,
      });
      await sm.loadInitialSessions("claude-code");
    });

    it("getAllSessions returns all sessions", () => {
      expect(sm.getAllSessions()).toHaveLength(2);
    });

    it("getActiveSessions returns only active sessions", async () => {
      expect(sm.getActiveSessions()).toHaveLength(0);

      await sm.activateSession("q1");

      expect(sm.getActiveSessions()).toHaveLength(1);
      expect(sm.getActiveSessions()[0].sessionId).toBe("q1");
    });

    it("hasActiveSession returns correct boolean", async () => {
      expect(sm.hasActiveSession("q1")).toBe(false);

      await sm.activateSession("q1");
      expect(sm.hasActiveSession("q1")).toBe(true);

      await sm.deactivateSession("q1");
      expect(sm.hasActiveSession("q1")).toBe(false);
    });

    it("getMessageCache returns empty array for unknown session", () => {
      expect(sm.getMessageCache("nonexistent")).toEqual([]);
    });

    it("clearMessageCache clears the cache", async () => {
      await sm.activateSession("q1");

      const entry = sm.getSession("q1")!;
      entry.messageCache.push({
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "test" }],
        timestamp: Date.now(),
      });

      expect(sm.getMessageCache("q1")).toHaveLength(1);

      sm.clearMessageCache("q1");
      expect(sm.getMessageCache("q1")).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // findInProgressToolCallById
  // -------------------------------------------------------------------------

  describe("findInProgressToolCall", () => {
    // Access via cast — private method tested through internal state for
    // precision; the public surface (attachJobProgressBridge) is too noisy.
    const COMPUTE_TRACK_ID = makeMcpToolId("libi-tracking", "libi.compute_object_track");

    function findById(
      instance: SessionManager,
      toolId: McpToolId,
    ) {
      return (instance as unknown as { findInProgressToolCall: (ids: McpToolId[], toolArgs: unknown | undefined) => { session: { sessionId: string }; toolCallId: string } | undefined }).findInProgressToolCall([toolId], undefined);
    }

    it("finds an unmatched tool-call in a single session", async () => {
      await sm.loadInitialSessions("claude-code");
      mockConnection.newSession.mockResolvedValueOnce({ sessionId: "fp-1" });
      await sm.createSession();

      const entry = sm.getSession("fp-1")!;
      entry.messageCache.push({
        id: "msg-1",
        role: "agent",
        parts: [{ type: "tool-call", toolCallId: "tc-1", toolId: COMPUTE_TRACK_ID, rawTitle: "libi.compute_object_track", args: {} }],
        timestamp: Date.now(),
      });

      const result = findById(sm, COMPUTE_TRACK_ID);
      expect(result).toBeDefined();
      expect(result!.toolCallId).toBe("tc-1");
      expect(result!.session.sessionId).toBe("fp-1");
    });

    it("returns undefined when no matching tool-call exists", async () => {
      await sm.loadInitialSessions("claude-code");
      mockConnection.newSession.mockResolvedValueOnce({ sessionId: "fp-2" });
      await sm.createSession();

      const result = findById(sm, makeMcpToolId("libi", "libi.nonexistent_tool"));
      expect(result).toBeUndefined();
    });

    it("skips matched (completed) tool-calls", async () => {
      await sm.loadInitialSessions("claude-code");
      mockConnection.newSession.mockResolvedValueOnce({ sessionId: "fp-3" });
      await sm.createSession();

      const entry = sm.getSession("fp-3")!;
      // Message has both a tool-call and its matching tool-result — completed
      entry.messageCache.push({
        id: "msg-1",
        role: "agent",
        parts: [
          { type: "tool-call", toolCallId: "tc-done", toolId: COMPUTE_TRACK_ID, rawTitle: "libi.compute_object_track", args: {} },
          { type: "tool-result", toolCallId: "tc-done", toolId: COMPUTE_TRACK_ID, rawTitle: "libi.compute_object_track", result: {}, success: true },
        ],
        timestamp: Date.now(),
      });

      const result = findById(sm, COMPUTE_TRACK_ID);
      expect(result).toBeUndefined();
    });

    it("finds the unmatched tool-call when a completed and unmatched one coexist", async () => {
      await sm.loadInitialSessions("claude-code");
      mockConnection.newSession.mockResolvedValueOnce({ sessionId: "fp-4" });
      await sm.createSession();

      const entry = sm.getSession("fp-4")!;
      // First message: completed tool-call
      entry.messageCache.push({
        id: "msg-1",
        role: "agent",
        parts: [
          { type: "tool-call", toolCallId: "tc-done", toolId: COMPUTE_TRACK_ID, rawTitle: "libi.compute_object_track", args: {} },
          { type: "tool-result", toolCallId: "tc-done", toolId: COMPUTE_TRACK_ID, rawTitle: "libi.compute_object_track", result: {}, success: true },
        ],
        timestamp: Date.now() - 5000,
      });
      // Second message: unmatched tool-call
      entry.messageCache.push({
        id: "msg-2",
        role: "agent",
        parts: [
          { type: "tool-call", toolCallId: "tc-open", toolId: COMPUTE_TRACK_ID, rawTitle: "libi.compute_object_track", args: {} },
        ],
        timestamp: Date.now(),
      });

      const result = findById(sm, COMPUTE_TRACK_ID);
      expect(result).toBeDefined();
      expect(result!.toolCallId).toBe("tc-open");
    });

    it("prefers the most-recently-active session (higher lastUsed) when two sessions have an unmatched call", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({ sessionId: "fp-older" });
      await sm.createSession();
      mockConnection.newSession.mockResolvedValueOnce({ sessionId: "fp-newer" });
      await sm.createSession();

      const older = sm.getSession("fp-older")!;
      const newer = sm.getSession("fp-newer")!;

      // Give older a lower lastUsed timestamp
      older.lastUsed = Date.now() - 10000;
      newer.lastUsed = Date.now();

      older.messageCache.push({
        id: "msg-old",
        role: "agent",
        parts: [{ type: "tool-call", toolCallId: "tc-old", toolId: COMPUTE_TRACK_ID, rawTitle: "libi.compute_object_track", args: {} }],
        timestamp: Date.now() - 10000,
      });
      newer.messageCache.push({
        id: "msg-new",
        role: "agent",
        parts: [{ type: "tool-call", toolCallId: "tc-new", toolId: COMPUTE_TRACK_ID, rawTitle: "libi.compute_object_track", args: {} }],
        timestamp: Date.now(),
      });

      const result = findById(sm, COMPUTE_TRACK_ID);
      expect(result).toBeDefined();
      // Should return from the session with the higher lastUsed (newer)
      expect(result!.toolCallId).toBe("tc-new");
      expect(result!.session.sessionId).toBe("fp-newer");
    });
  });

  // -------------------------------------------------------------------------
  // shutdown
  // -------------------------------------------------------------------------

  describe("shutdown", () => {
    it("deactivates all active sessions and clears state", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "shut-1",
      });
      await sm.createSession();

      expect(sm.getAllSessions().length).toBeGreaterThan(0);

      await sm.shutdown();

      expect(sm.getAllSessions()).toHaveLength(0);
      expect(sm.activeAgentId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Standby session
  // -------------------------------------------------------------------------

  describe("standby sessions", () => {
    it("createStandbySession creates a session without adding to the map", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "standby-1",
      });

      await sm.createStandbySession();

      // Standby should not appear as a regular session
      expect(sm.getSession("standby-1")).toBeUndefined();
    });

    it("invalidateStandbySession closes old and creates new", async () => {
      await sm.loadInitialSessions("claude-code");

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "standby-old",
      });
      await sm.createStandbySession();

      mockConnection.newSession.mockResolvedValueOnce({
        sessionId: "standby-new",
      });

      sm.invalidateStandbySession();

      // Should have attempted to close the old standby
      expect(mockConnection.closeSession).toHaveBeenCalledWith({
        sessionId: "standby-old",
      });
    });
  });
});
